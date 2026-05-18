import pytest

from app.conversion import service
from app.core.errors import AIEngineError
from app.engines.passthrough import PassthroughVoiceEngine


@pytest.fixture
def engine(settings):
    return PassthroughVoiceEngine(settings)


def test_full_convert_end_to_end(engine, make_wav, tmp_path):
    reference = make_wav("ref.wav", duration_seconds=3.0)
    source = make_wav("source.wav", duration_seconds=2.0, seed=5)
    result = service.full_convert(
        engine,
        reference_files=[reference],
        source_audio=source,
        output_path=tmp_path / "out.wav",
        artifact_path=tmp_path / "artifact.json",
    )
    assert result.status == "completed"
    assert result.engine == "passthrough"
    assert (tmp_path / "out.wav").exists()
    assert result.peak_rss_mb is not None


def test_convert_raises_for_invalid_source(engine, make_wav, tmp_path):
    reference = make_wav("ref.wav")
    artifact = tmp_path / "artifact.json"
    service.prepare_target_voice(engine, [reference], artifact)

    bogus = tmp_path / "bogus.wav"
    bogus.write_bytes(b"not audio")
    with pytest.raises(AIEngineError):
        service.convert(engine, bogus, artifact, tmp_path / "out.wav")
