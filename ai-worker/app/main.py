"""CLI entry point: `python -m app.main <command> ...`.

This is the only interface the FastAPI backend talks to in Phase 3 (invoked
as a subprocess — see docs/phase3-ai-conversion.md "Why a subprocess, not a
resident service"). Every command that can succeed or fail prints exactly
one JSON object as its LAST stdout line; that is the contract callers
(including the backend) parse. Human-readable progress/logging goes to
stderr via the logging module so it never corrupts that contract.
"""

import argparse
import json
import logging
import sys
from pathlib import Path

from app.audio.chunking import convert_chunked
from app.audio.postprocessing import write_wav
from app.audio.preprocessing import load_mono
from app.benchmark.report import format_chunked_report, format_offline_report
from app.benchmark.runner import run_chunked_benchmark, run_offline_benchmark
from app.conversion import service
from app.conversion.result import ConversionResult
from app.core.config import EngineName, get_settings
from app.core.errors import AIEngineError, AIErrorCode
from app.core.logging import configure_logging, log_device_banner
from app.engines.registry import get_engine

logger = logging.getLogger("app.main")


def _build_engine(engine_name: str | None):
    settings = get_settings()
    name = EngineName(engine_name) if engine_name else settings.engine
    engine = get_engine(name, settings)
    return engine, settings


def _print_result(result_dict: dict, result_json_path: str | None) -> None:
    line = json.dumps(result_dict)
    if result_json_path:
        Path(result_json_path).write_text(line)
    print(line)


def cmd_convert(args: argparse.Namespace) -> int:
    engine, _settings = _build_engine(args.engine)
    log_device_banner()
    try:
        if args.prepared_voice:
            # Cache hit path: the caller (the backend) already has a prepared
            # artifact for this target voice — skip prepare_target_voice
            # entirely rather than paying its cost on every conversion.
            result = service.convert(
                engine,
                source_audio=Path(args.source),
                prepared_voice_path=Path(args.prepared_voice),
                output_path=Path(args.output),
            )
        else:
            if not args.reference:
                raise AIEngineError(
                    AIErrorCode.TARGET_VOICE_NOT_READY, "Must pass --reference or --prepared-voice"
                )
            result = service.full_convert(
                engine,
                reference_files=[Path(r) for r in args.reference],
                source_audio=Path(args.source),
                output_path=Path(args.output),
                artifact_path=Path(args.artifact)
                if args.artifact
                else Path(args.output).with_suffix(".voice.pt"),
            )
        _print_result(result.to_dict(), args.result_json)
        return 0
    except AIEngineError as exc:
        logger.error("convert failed: %s", exc.message)
        _print_result(
            ConversionResult.failed(engine="unknown", device="cpu", error=exc.to_dict()).to_dict(),
            args.result_json,
        )
        return 1
    finally:
        engine.unload()


def cmd_prepare(args: argparse.Namespace) -> int:
    engine, _settings = _build_engine(args.engine)
    log_device_banner()
    try:
        prepared_id = service.prepare_target_voice(
            engine, [Path(r) for r in args.reference], Path(args.output)
        )
        _print_result(
            {"status": "completed", "prepared_voice_id": prepared_id, "artifact_path": args.output},
            args.result_json,
        )
        return 0
    except AIEngineError as exc:
        logger.error("prepare failed: %s", exc.message)
        _print_result({"status": "failed", "error": exc.to_dict()}, args.result_json)
        return 1
    finally:
        engine.unload()


def cmd_chunked_convert(args: argparse.Namespace) -> int:
    engine, settings = _build_engine(args.engine)
    log_device_banner()
    artifact_path = Path(args.artifact) if args.artifact else Path(args.output).with_suffix(".voice.pt")
    try:
        engine.load()
        if args.reference:
            # chunked-convert is the streaming-style path — use the same
            # (much shorter) reference cap the resident server uses, not the
            # offline default. See docs/phase3.1-resident-engine.md "Root
            # Cause": this is what previously made a CLI-generated
            # "streaming" artifact misleadingly slow (still on the offline
            # 25s cap) versus what the resident server actually measures.
            service.prepare_target_voice(
                engine,
                [Path(r) for r in args.reference],
                artifact_path,
                max_reference_seconds=settings.stream_reference_seconds,
            )
        audio, sample_rate = load_mono(Path(args.source))
        stitched, latencies = convert_chunked(
            engine,
            audio,
            sample_rate,
            artifact_path,
            chunk_ms=args.chunk_ms,
            overlap_ms=args.overlap_ms,
        )
        write_wav(Path(args.output), stitched, sample_rate)
        from app.audio.metrics import LatencyStats, compute_rtf

        stats = LatencyStats.from_seconds(latencies)
        source_duration = len(audio) / sample_rate if sample_rate else 0.0
        _print_result(
            {
                "status": "completed",
                "chunk_ms": args.chunk_ms,
                "overlap_ms": args.overlap_ms,
                "chunks": len(latencies),
                "avg_latency_ms": stats.avg_ms,
                "p95_latency_ms": stats.p95_ms,
                "rtf": compute_rtf(sum(latencies), source_duration),
                "output_path": args.output,
            },
            args.result_json,
        )
        return 0
    except AIEngineError as exc:
        logger.error("chunked-convert failed: %s", exc.message)
        _print_result({"status": "failed", "error": exc.to_dict()}, args.result_json)
        return 1
    finally:
        engine.unload()


def cmd_benchmark(args: argparse.Namespace) -> int:
    engine, _settings = _build_engine(args.engine)
    log_device_banner()
    artifact_path = Path(args.artifact) if args.artifact else Path("./benchmark_artifact.voice.pt")
    output_path = Path(args.output) if args.output else Path("./benchmark_output.wav")
    try:
        result = run_offline_benchmark(
            engine, [Path(r) for r in args.reference], Path(args.source), output_path, artifact_path
        )
        print(format_offline_report(result))
        if args.result_json:
            Path(args.result_json).write_text(json.dumps(result.__dict__, default=lambda o: o.__dict__))
        return 0
    except AIEngineError as exc:
        logger.error("benchmark failed: %s", exc.message)
        print(json.dumps({"status": "failed", "error": exc.to_dict()}))
        return 1
    finally:
        engine.unload()


def cmd_chunked_benchmark(args: argparse.Namespace) -> int:
    engine, settings = _build_engine(args.engine)
    log_device_banner()
    artifact_path = Path(args.artifact) if args.artifact else Path("./benchmark_artifact.voice.pt")
    chunk_sizes = [int(v) for v in args.chunk_sizes.split(",")]
    try:
        engine.load()
        if args.reference:
            # See cmd_chunked_convert — the streaming reference cap, not the
            # offline default, so this benchmark matches what the resident
            # server actually does.
            service.prepare_target_voice(
                engine,
                [Path(r) for r in args.reference],
                artifact_path,
                max_reference_seconds=settings.stream_reference_seconds,
            )
        results = run_chunked_benchmark(
            engine, artifact_path, Path(args.source), chunk_sizes, args.overlap_ms
        )
        print(format_chunked_report(results))
        return 0
    except AIEngineError as exc:
        logger.error("chunked-benchmark failed: %s", exc.message)
        print(json.dumps({"status": "failed", "error": exc.to_dict()}))
        return 1
    finally:
        engine.unload()


def cmd_profile_chunk(args: argparse.Namespace) -> int:
    """Phase 3.1 Step 2: real, measured per-stage timing for one chunk —
    never guessed. See docs/phase3-ai-conversion.md 'Profiling Results'."""
    from app.audio.preprocessing import load_mono
    from app.audio.profiling import Profiler

    engine, _settings = _build_engine(args.engine)
    log_device_banner()
    artifact_path = Path(args.artifact) if args.artifact else Path("./profile_artifact.voice.pt")
    try:
        engine.load()
        engine.warmup()
        if args.reference:
            service.prepare_target_voice(engine, [Path(r) for r in args.reference], artifact_path)

        audio, sample_rate = load_mono(Path(args.source))
        chunk_len = int(sample_rate * args.chunk_ms / 1000)
        chunk = audio[:chunk_len]

        profiler = Profiler(enabled=True)
        engine.set_profiler(profiler)
        for _ in range(args.repeats):
            engine.process_chunk(chunk, sample_rate, artifact_path)
        engine.set_profiler(None)

        print(profiler.timings.report(chunk_duration_seconds=len(chunk) / sample_rate))
        if args.result_json:
            Path(args.result_json).write_text(json.dumps(profiler.timings.to_dict()))
        return 0
    except AIEngineError as exc:
        logger.error("profile-chunk failed: %s", exc.message)
        print(json.dumps({"status": "failed", "error": exc.to_dict()}))
        return 1
    finally:
        engine.unload()


def cmd_health_check(args: argparse.Namespace) -> int:
    engine, settings = _build_engine(args.engine)
    try:
        if args.deep:
            engine.load()
        health = engine.health_check()
        print(json.dumps(health.to_dict()))
        return 0
    finally:
        engine.unload()


def cmd_serve(args: argparse.Namespace) -> int:
    """Phase 3.1: the resident streaming engine — see
    docs/phase3.1-resident-engine.md. Loads the model once and keeps it
    resident for the lifetime of this process; NOT the subprocess-per-request
    path the backend's offline /convert endpoint uses."""
    import asyncio

    from app.server.websocket_server import run_server

    engine, settings = _build_engine(args.engine)
    if args.host:
        settings = settings.model_copy(update={"server_host": args.host})
    if args.port:
        settings = settings.model_copy(update={"server_port": args.port})
    log_device_banner()
    logger.info(
        "Starting resident AI engine (model loads on first engine.load_voice or immediately if --preload)"
    )
    if args.preload:
        engine.load()
        engine.warmup()
    asyncio.run(run_server(engine, settings))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.main")
    parser.add_argument("--engine", choices=[e.value for e in EngineName], default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    p_convert = sub.add_parser("convert", help="Offline: reference(s) + source -> converted.wav")
    p_convert.add_argument("--source", required=True)
    p_convert.add_argument("--reference", action="append", default=[])
    p_convert.add_argument(
        "--prepared-voice", default=None, help="Reuse an existing artifact instead of --reference"
    )
    p_convert.add_argument("--output", required=True)
    p_convert.add_argument("--artifact", default=None, help="Where to write the prepared-voice artifact")
    p_convert.add_argument("--result-json", default=None)
    p_convert.set_defaults(func=cmd_convert)

    p_prepare = sub.add_parser("prepare", help="Prepare a target voice artifact only")
    p_prepare.add_argument("--reference", action="append", required=True)
    p_prepare.add_argument("--output", required=True)
    p_prepare.add_argument("--result-json", default=None)
    p_prepare.set_defaults(func=cmd_prepare)

    p_chunked = sub.add_parser("chunked-convert", help="Chunk-by-chunk offline conversion")
    p_chunked.add_argument("--source", required=True)
    p_chunked.add_argument("--reference", action="append", default=[])
    p_chunked.add_argument("--artifact", default=None)
    p_chunked.add_argument("--output", required=True)
    p_chunked.add_argument("--chunk-ms", type=int, default=300)
    p_chunked.add_argument("--overlap-ms", type=int, default=40)
    p_chunked.add_argument("--result-json", default=None)
    p_chunked.set_defaults(func=cmd_chunked_convert)

    p_bench = sub.add_parser("benchmark", help="Full offline benchmark report")
    p_bench.add_argument("--source", required=True)
    p_bench.add_argument("--reference", action="append", required=True)
    p_bench.add_argument("--artifact", default=None)
    p_bench.add_argument("--output", default=None)
    p_bench.add_argument("--result-json", default=None)
    p_bench.set_defaults(func=cmd_benchmark)

    p_cbench = sub.add_parser("chunked-benchmark", help="Benchmark multiple chunk sizes")
    p_cbench.add_argument("--source", required=True)
    p_cbench.add_argument("--reference", action="append", default=[])
    p_cbench.add_argument("--artifact", default=None)
    p_cbench.add_argument("--chunk-sizes", default="100,200,300,500,1000")
    p_cbench.add_argument("--overlap-ms", type=int, default=40)
    p_cbench.set_defaults(func=cmd_chunked_benchmark)

    p_profile = sub.add_parser("profile-chunk", help="Per-stage timing breakdown for one chunk")
    p_profile.add_argument("--source", required=True)
    p_profile.add_argument("--reference", action="append", default=[])
    p_profile.add_argument("--artifact", default=None)
    p_profile.add_argument("--chunk-ms", type=int, default=500)
    p_profile.add_argument("--repeats", type=int, default=1, help="Average over N repeats")
    p_profile.add_argument("--result-json", default=None)
    p_profile.set_defaults(func=cmd_profile_chunk)

    p_health = sub.add_parser("health-check", help="Report engine/config health")
    p_health.add_argument(
        "--deep", action="store_true", help="Actually load the model, not just check config"
    )
    p_health.set_defaults(func=cmd_health_check)

    p_serve = sub.add_parser("serve", help="Start the resident streaming engine (local WebSocket, Phase 3.1)")
    p_serve.add_argument("--host", default=None, help="Default: 127.0.0.1 (loopback only)")
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.add_argument(
        "--preload", action="store_true", help="Load the model immediately instead of lazily"
    )
    p_serve.set_defaults(func=cmd_serve)

    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
