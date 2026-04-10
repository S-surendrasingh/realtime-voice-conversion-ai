import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import psutil

from app.audio.chunking import convert_chunked
from app.audio.metrics import LatencyStats, compute_rtf, track_resource_usage
from app.audio.preprocessing import load_mono
from app.audio.validation import validate_and_inspect
from app.engines.base import VoiceConversionEngine


@dataclass
class SystemInfo:
    os: str
    cpu_model: str
    logical_cores: int
    ram_total_gb: float
    python_version: str

    @classmethod
    def collect(cls) -> "SystemInfo":
        return cls(
            os=f"{platform.system()} {platform.release()}",
            cpu_model=platform.processor() or platform.uname().processor or "unknown",
            logical_cores=psutil.cpu_count(logical=True) or 0,
            ram_total_gb=psutil.virtual_memory().total / (1024**3),
            python_version=sys.version.split()[0],
        )


@dataclass
class OfflineBenchmarkResult:
    system: SystemInfo
    engine_name: str
    model_version: str | None
    device: str
    reference_duration_seconds: float
    reference_sample_count: int
    reference_prep_seconds: float
    source_duration_seconds: float
    model_load_seconds: float
    warmup_seconds: float
    conversion_seconds: float
    rtf: float
    peak_rss_mb: float
    avg_cpu_percent: float
    output_duration_seconds: float
    output_path: str


def run_offline_benchmark(
    engine: VoiceConversionEngine,
    reference_files: list[Path],
    source_audio: Path,
    output_path: Path,
    artifact_path: Path,
) -> OfflineBenchmarkResult:
    system = SystemInfo.collect()

    reference_infos = [validate_and_inspect(p) for p in reference_files]
    source_info = validate_and_inspect(source_audio)

    t0 = time.monotonic()
    engine.load()
    model_load_seconds = time.monotonic() - t0

    t0 = time.monotonic()
    engine.warmup()
    warmup_seconds = time.monotonic() - t0

    t0 = time.monotonic()
    engine.prepare_target_voice(reference_files, artifact_path)
    reference_prep_seconds = time.monotonic() - t0

    with track_resource_usage() as usage:
        t0 = time.monotonic()
        metrics = engine.convert_file(source_audio, artifact_path, output_path)
        conversion_seconds = time.monotonic() - t0

    health = engine.health_check()

    return OfflineBenchmarkResult(
        system=system,
        engine_name=health.engine_name,
        model_version=health.model_version,
        device=health.device,
        reference_duration_seconds=sum(i.duration_seconds for i in reference_infos),
        reference_sample_count=len(reference_infos),
        reference_prep_seconds=reference_prep_seconds,
        source_duration_seconds=source_info.duration_seconds,
        model_load_seconds=model_load_seconds,
        warmup_seconds=warmup_seconds,
        conversion_seconds=conversion_seconds,
        rtf=compute_rtf(conversion_seconds, source_info.duration_seconds),
        peak_rss_mb=usage.get("peak_rss_mb", 0.0),
        avg_cpu_percent=usage.get("avg_cpu_percent", 0.0),
        output_duration_seconds=metrics.output_duration_seconds,
        output_path=str(output_path),
    )


@dataclass
class ChunkSizeResult:
    chunk_ms: int
    overlap_ms: int
    latency: LatencyStats
    rtf: float
    output_duration_seconds: float


def run_chunked_benchmark(
    engine: VoiceConversionEngine,
    prepared_voice_path: Path,
    source_audio: Path,
    chunk_sizes_ms: list[int],
    overlap_ms: int,
) -> list[ChunkSizeResult]:
    audio, sample_rate = load_mono(source_audio)
    source_duration = len(audio) / sample_rate

    results = []
    for chunk_ms in chunk_sizes_ms:
        t0 = time.monotonic()
        stitched, latencies = convert_chunked(
            engine, audio, sample_rate, prepared_voice_path, chunk_ms, overlap_ms
        )
        total_time = time.monotonic() - t0
        results.append(
            ChunkSizeResult(
                chunk_ms=chunk_ms,
                overlap_ms=overlap_ms,
                latency=LatencyStats.from_seconds(latencies),
                rtf=compute_rtf(total_time, source_duration),
                output_duration_seconds=len(stitched) / sample_rate if sample_rate else 0.0,
            )
        )
    return results
