"""Unit tests for OpenVoiceOnnxEngine using a fake ONNX Runtime session —
no real model download. Mirrors onnxruntime.InferenceSession's `.run()`
interface closely enough to exercise the engine's own logic (artifact
caching, shape handling, error mapping) in isolation. Real-model tests are
in tests/ai/test_openvoice_onnx_smoke.py (marked `ai`).
"""

import numpy as np
import pytest

from app.core.errors import AIEngineError, AIErrorCode
from app.engines.base import EngineState
from app.engines.openvoice_onnx import OpenVoiceOnnxEngine


class FakeOnnxSession:
    """Stands in for onnxruntime.InferenceSession. `run_fn(input_feed) ->
    list[np.ndarray]` lets a test control exactly what a call returns,
    including raising to simulate a runtime error."""

    def __init__(self, run_fn):
        self._run_fn = run_fn
        self.call_count = 0
        self.last_input_feed = None

    def run(self, output_names, input_feed):
        self.call_count += 1
        self.last_input_feed = input_feed
        return self._run_fn(input_feed)


def _fake_extract_run(input_feed):
    return [np.ones((1, 256), dtype="float32")]


def _fake_clone_run(input_feed):
    n = input_feed["audio"].shape[-1] * 256  # roughly matches hop_length upsampling
    audio = 0.1 * np.sin(np.linspace(0, 10, n)).astype("float32")
    mask = np.ones((1, 1, input_feed["audio"].shape[-1]), dtype="float32")
    latent = np.zeros((1, 192, input_feed["audio"].shape[-1]), dtype="float32")
    return [audio[None, None, :], mask, latent, latent, latent]


@pytest.fixture
def engine(settings):
    e = OpenVoiceOnnxEngine(settings)
    e._extract_session = FakeOnnxSession(_fake_extract_run)
    e._clone_session = FakeOnnxSession(_fake_clone_run)
    e._state = EngineState.READY
    return e


def test_prepare_target_voice_writes_artifact(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav", duration_seconds=3.0)
    artifact = tmp_path / "target.npy"
    prepared_id = engine.prepare_target_voice([ref], artifact)
    assert prepared_id
    assert artifact.exists()
    loaded = np.load(artifact)
    assert loaded.shape == (1, 256, 1)


def test_prepare_target_voice_is_deterministic(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav", duration_seconds=3.0)
    id_a = engine.prepare_target_voice([ref], tmp_path / "a.npy")
    id_b = engine.prepare_target_voice([ref], tmp_path / "b.npy")
    assert id_a == id_b


def test_prepare_target_voice_changes_when_reference_changes(engine, make_wav, tmp_path):
    ref_a = make_wav("ref_a.wav", seed=1)
    ref_b = make_wav("ref_b.wav", seed=2)
    id_a = engine.prepare_target_voice([ref_a], tmp_path / "a.npy")
    id_b = engine.prepare_target_voice([ref_b], tmp_path / "b.npy")
    assert id_a != id_b


def test_convert_file_produces_valid_output(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav", duration_seconds=3.0)
    source = make_wav("source.wav", duration_seconds=2.0, seed=5)
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    output = tmp_path / "out.wav"
    metrics = engine.convert_file(source, artifact, output)

    assert output.exists()
    assert metrics.source_duration_seconds == pytest.approx(2.0, abs=0.05)
    assert metrics.output_sample_rate == engine._settings.openvoice_sample_rate


def test_convert_file_raises_when_target_not_prepared(engine, make_wav, tmp_path):
    source = make_wav("source.wav")
    with pytest.raises(AIEngineError) as exc_info:
        engine.convert_file(source, tmp_path / "missing.npy", tmp_path / "out.wav")
    assert exc_info.value.code == AIErrorCode.TARGET_VOICE_NOT_READY


def test_convert_file_wraps_onnx_runtime_error(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    source = make_wav("source.wav", seed=3)
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    def _boom(_input_feed):
        raise RuntimeError("simulated ONNX Runtime failure")

    engine._clone_session = FakeOnnxSession(_boom)
    with pytest.raises(AIEngineError) as exc_info:
        engine.convert_file(source, artifact, tmp_path / "out.wav")
    assert exc_info.value.code == AIErrorCode.CONVERSION_FAILED


def test_convert_file_rejects_invalid_source(engine, tmp_path, make_wav):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)
    bogus = tmp_path / "bogus.wav"
    bogus.write_bytes(b"not audio")
    with pytest.raises(AIEngineError):
        engine.convert_file(bogus, artifact, tmp_path / "out.wav")


def test_artifact_is_cached_across_calls(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    source = make_wav("source.wav", seed=7)
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)
    engine.convert_file(source, artifact, tmp_path / "out1.wav")
    engine.convert_file(source, artifact, tmp_path / "out2.wav")
    assert str(artifact) in engine._artifact_cache


def test_process_chunk_returns_numpy_array(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    chunk = np.zeros(11025, dtype="float32")
    result = engine.process_chunk(chunk, 22050, artifact)
    assert isinstance(result, np.ndarray)
    assert engine._clone_session.call_count == 1


def test_process_chunk_extracts_src_tone_fresh_each_call(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    extract_calls_before = engine._extract_session.call_count
    engine.process_chunk(np.zeros(5000, dtype="float32"), 22050, artifact)
    engine.process_chunk(np.zeros(5000, dtype="float32"), 22050, artifact)
    # +1 for the prepare_target_voice call already made, +2 for the two chunks
    assert engine._extract_session.call_count == extract_calls_before + 2


def test_create_stream_session_processes_and_closes(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    session = engine.create_stream(artifact)
    output, sr = session.process(np.zeros(11025, dtype="float32"), 22050)
    assert sr == engine._settings.openvoice_sample_rate
    assert isinstance(output, np.ndarray)
    session.close()  # must not raise


def test_create_stream_crossfades_consecutive_chunks(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "target.npy"
    engine.prepare_target_voice([ref], artifact)

    session = engine.create_stream(artifact)
    out1, _ = session.process(np.zeros(11025, dtype="float32"), 22050)
    out2, _ = session.process(np.zeros(11025, dtype="float32"), 22050)
    assert len(out1) > 0
    assert len(out2) > 0
    session.close()


def test_health_check_reports_state(engine):
    health = engine.health_check()
    assert health.engine_name == "openvoice_onnx"
    assert health.device == "cpu"
    assert health.state == EngineState.READY


def test_unload_clears_sessions_and_cache(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    engine.prepare_target_voice([ref], tmp_path / "target.npy")
    engine.unload()
    assert engine.health_check().state == EngineState.NOT_LOADED
    assert engine._extract_session is None
    assert engine._artifact_cache == {}
