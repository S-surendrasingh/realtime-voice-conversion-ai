import pytest

from app.core.errors import AIEngineError
from app.engines.base import EngineHealth, EngineState, VoiceConversionEngine
from app.engines.passthrough import PassthroughVoiceEngine


@pytest.fixture
def engine(settings) -> PassthroughVoiceEngine:
    e = PassthroughVoiceEngine(settings)
    e.load()
    return e


def test_conforms_to_engine_interface(engine):
    assert isinstance(engine, VoiceConversionEngine)


def test_health_check_reports_ready_after_load(engine):
    health = engine.health_check()
    assert isinstance(health, EngineHealth)
    assert health.state == EngineState.READY
    assert health.device == "cpu"
    assert health.loaded is True


def test_health_check_reports_not_loaded_before_load(settings):
    engine = PassthroughVoiceEngine(settings)
    assert engine.health_check().loaded is False


def test_prepare_target_voice_requires_at_least_one_reference(engine, tmp_path):
    with pytest.raises(AIEngineError) as exc_info:
        engine.prepare_target_voice([], tmp_path / "artifact.json")
    assert exc_info.value.code.value == "TARGET_VOICE_PREPARATION_FAILED"


def test_prepare_target_voice_is_deterministic(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    id_1 = engine.prepare_target_voice([ref], tmp_path / "a1.json")
    id_2 = engine.prepare_target_voice([ref], tmp_path / "a2.json")
    assert id_1 == id_2


def test_prepare_target_voice_changes_when_reference_changes(engine, make_wav, tmp_path):
    ref_a = make_wav("ref_a.wav", seed=1)
    ref_b = make_wav("ref_b.wav", seed=2)
    id_a = engine.prepare_target_voice([ref_a], tmp_path / "a.json")
    id_b = engine.prepare_target_voice([ref_b], tmp_path / "b.json")
    assert id_a != id_b


def test_convert_file_round_trips_real_audio(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    source = make_wav("source.wav", duration_seconds=3.0, seed=9)
    artifact = tmp_path / "artifact.json"
    engine.prepare_target_voice([ref], artifact)

    output = tmp_path / "out.wav"
    metrics = engine.convert_file(source, artifact, output)

    assert output.exists()
    assert metrics.source_duration_seconds == pytest.approx(3.0, abs=0.05)
    assert metrics.rtf >= 0


def test_convert_file_raises_when_prepared_voice_missing(engine, make_wav, tmp_path):
    source = make_wav("source.wav")
    with pytest.raises(AIEngineError) as exc_info:
        engine.convert_file(source, tmp_path / "missing.json", tmp_path / "out.wav")
    assert exc_info.value.code.value == "TARGET_VOICE_NOT_READY"


def test_convert_file_rejects_invalid_source(engine, make_wav, tmp_path):
    ref = make_wav("ref.wav")
    artifact = tmp_path / "artifact.json"
    engine.prepare_target_voice([ref], artifact)

    bogus = tmp_path / "bogus.wav"
    bogus.write_bytes(b"not an audio file")
    with pytest.raises(AIEngineError) as exc_info:
        engine.convert_file(bogus, artifact, tmp_path / "out.wav")
    assert exc_info.value.code.value == "SOURCE_AUDIO_INVALID"


def test_process_chunk_returns_same_shape(engine, tmp_path):
    import numpy as np

    chunk = np.zeros(1024, dtype="float32")
    out = engine.process_chunk(chunk, 22050, tmp_path / "unused.json")
    assert out.shape == chunk.shape


def test_create_stream_session_processes_and_closes(engine, tmp_path):
    import numpy as np

    session = engine.create_stream(tmp_path / "unused.json")
    chunk = np.ones(256, dtype="float32")
    result, output_sample_rate = session.process(chunk, 22050)
    assert (result == chunk).all()
    assert output_sample_rate == 22050
    session.close()  # must not raise


def test_unload_resets_state(engine):
    engine.unload()
    assert engine.health_check().state == EngineState.NOT_LOADED
