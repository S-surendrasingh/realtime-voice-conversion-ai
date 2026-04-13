from pathlib import Path

from app.audio.metrics import track_resource_usage
from app.audio.validation import validate_and_inspect
from app.conversion.result import ConversionResult
from app.engines.base import VoiceConversionEngine


def prepare_target_voice(
    engine: VoiceConversionEngine,
    reference_files: list[Path],
    artifact_path: Path,
    max_reference_seconds: float | None = None,
) -> str:
    for ref in reference_files:
        validate_and_inspect(ref)
    engine.load()
    return engine.prepare_target_voice(reference_files, artifact_path, max_reference_seconds=max_reference_seconds)


def convert(
    engine: VoiceConversionEngine,
    source_audio: Path,
    prepared_voice_path: Path,
    output_path: Path,
) -> ConversionResult:
    validate_and_inspect(source_audio)
    engine.load()
    engine.warmup()
    with track_resource_usage() as usage:
        metrics = engine.convert_file(source_audio, prepared_voice_path, output_path)
    metrics.peak_rss_mb = usage.get("peak_rss_mb")
    health = engine.health_check()
    return ConversionResult.from_metrics(
        metrics,
        engine=health.engine_name,
        model_version=health.model_version,
        device=health.device,
        output_path=str(output_path),
    )


def full_convert(
    engine: VoiceConversionEngine,
    reference_files: list[Path],
    source_audio: Path,
    output_path: Path,
    artifact_path: Path,
) -> ConversionResult:
    """The single-shot path the spec's `convert --source --reference
    --output` CLI example uses: prepare + convert in one call, for when
    there's no separately-cached artifact yet."""
    prepare_target_voice(engine, reference_files, artifact_path)
    return convert(engine, source_audio, artifact_path, output_path)
