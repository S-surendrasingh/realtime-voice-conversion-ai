from app.benchmark.report import format_chunked_report, format_offline_report
from app.benchmark.runner import run_chunked_benchmark, run_offline_benchmark
from app.engines.passthrough import PassthroughVoiceEngine


def test_run_offline_benchmark_with_passthrough(settings, make_wav, tmp_path):
    engine = PassthroughVoiceEngine(settings)
    reference = make_wav("ref.wav", duration_seconds=3.0)
    source = make_wav("source.wav", duration_seconds=2.0, seed=7)

    result = run_offline_benchmark(
        engine, [reference], source, tmp_path / "out.wav", tmp_path / "artifact.json"
    )

    assert result.engine_name == "passthrough"
    assert result.source_duration_seconds > 0
    assert result.rtf >= 0
    assert result.system.logical_cores > 0
    assert result.system.ram_total_gb > 0


def test_format_offline_report_includes_feasibility_verdict(settings, make_wav, tmp_path):
    engine = PassthroughVoiceEngine(settings)
    reference = make_wav("ref.wav", duration_seconds=3.0)
    source = make_wav("source.wav", duration_seconds=2.0, seed=8)
    result = run_offline_benchmark(
        engine, [reference], source, tmp_path / "out.wav", tmp_path / "artifact.json"
    )

    report = format_offline_report(result)

    assert "RESULT" in report
    assert "Realtime feasibility" in report
    assert "PASS" in report  # passthrough is always well under RTF 1.0


def test_run_chunked_benchmark_with_passthrough(settings, make_wav, tmp_path):
    engine = PassthroughVoiceEngine(settings)
    engine.load()
    reference = make_wav("ref.wav", duration_seconds=3.0)
    artifact = tmp_path / "artifact.json"
    engine.prepare_target_voice([reference], artifact)
    source = make_wav("source.wav", duration_seconds=2.0, seed=9)

    results = run_chunked_benchmark(engine, artifact, source, chunk_sizes_ms=[100, 300], overlap_ms=20)

    assert len(results) == 2
    assert all(r.rtf >= 0 for r in results)


def test_format_chunked_report_shows_best_chunk_size(settings, make_wav, tmp_path):
    engine = PassthroughVoiceEngine(settings)
    engine.load()
    reference = make_wav("ref.wav", duration_seconds=3.0)
    artifact = tmp_path / "artifact.json"
    engine.prepare_target_voice([reference], artifact)
    source = make_wav("source.wav", duration_seconds=2.0, seed=10)

    results = run_chunked_benchmark(engine, artifact, source, chunk_sizes_ms=[100, 300], overlap_ms=20)
    report = format_chunked_report(results)

    assert "Best chunk size" in report
    assert "chunk_ms" in report
