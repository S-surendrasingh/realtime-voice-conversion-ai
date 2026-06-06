import pytest

from app.audio.validation import validate_and_inspect
from app.core.errors import AIEngineError


def test_validate_and_inspect_accepts_real_wav(make_wav):
    path = make_wav("ok.wav", duration_seconds=2.0)
    info = validate_and_inspect(path)
    assert info.duration_seconds == pytest.approx(2.0, abs=0.05)
    assert info.sample_rate == 22050


def test_validate_and_inspect_rejects_missing_file(tmp_path):
    with pytest.raises(AIEngineError) as exc_info:
        validate_and_inspect(tmp_path / "nope.wav")
    assert exc_info.value.code.value == "SOURCE_AUDIO_INVALID"


def test_validate_and_inspect_rejects_empty_file(tmp_path):
    path = tmp_path / "empty.wav"
    path.write_bytes(b"")
    with pytest.raises(AIEngineError):
        validate_and_inspect(path)


def test_validate_and_inspect_rejects_unsupported_extension(tmp_path):
    path = tmp_path / "audio.mp3"
    path.write_bytes(b"fake mp3 bytes")
    with pytest.raises(AIEngineError):
        validate_and_inspect(path)


def test_validate_and_inspect_rejects_corrupt_audio(tmp_path):
    path = tmp_path / "corrupt.wav"
    path.write_bytes(b"RIFF....WAVEfmt not really audio")
    with pytest.raises(AIEngineError):
        validate_and_inspect(path)


def test_validate_and_inspect_rejects_too_short_audio(make_wav):
    path = make_wav("tiny.wav", duration_seconds=0.05)
    with pytest.raises(AIEngineError):
        validate_and_inspect(path)
