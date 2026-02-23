import pytest

from app.core.config import Settings
from app.services.audio_validation import AudioValidationService
from tests.audio_fixtures import make_wav_bytes


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        min_sample_duration_seconds=3.0,
        max_sample_duration_seconds=60.0,
        max_sample_file_size_mb=25,
    )


@pytest.fixture
def validator(settings: Settings) -> AudioValidationService:
    return AudioValidationService(settings)


def test_valid_mono_wav_passes(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=5.0, sample_rate=44100, channels=1)
    result = validator.validate(content, filename="sample.wav")

    assert result.valid
    assert result.errors == []
    assert result.sample_rate == 44100
    assert result.channels == 1
    assert result.duration_seconds == pytest.approx(5.0, abs=0.01)
    assert result.format == "WAV"


def test_valid_stereo_wav_passes(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=10.0, channels=2)
    result = validator.validate(content, filename="sample.wav")

    assert result.valid
    assert result.channels == 2


def test_audio_shorter_than_minimum_is_rejected(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=1.0)
    result = validator.validate(content, filename="short.wav")

    assert not result.valid
    assert any("shorter than the minimum" in error for error in result.errors)


def test_audio_longer_than_maximum_is_rejected(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=70.0)
    result = validator.validate(content, filename="long.wav")

    assert not result.valid
    assert any("exceeds the maximum allowed duration" in error for error in result.errors)


def test_empty_file_is_rejected(validator: AudioValidationService) -> None:
    result = validator.validate(b"", filename="empty.wav")

    assert not result.valid
    assert result.errors == ["Audio file is empty."]


def test_corrupt_audio_is_rejected(validator: AudioValidationService) -> None:
    result = validator.validate(b"this is not a real wav file" * 10, filename="corrupt.wav")

    assert not result.valid
    assert any("corrupt" in error.lower() for error in result.errors)


def test_unsupported_extension_is_rejected(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=5.0)
    result = validator.validate(content, filename="sample.mp3")

    assert not result.valid
    assert any("Unsupported file extension" in error for error in result.errors)


def test_unsupported_channel_count_is_rejected(validator: AudioValidationService) -> None:
    content = make_wav_bytes(duration_seconds=5.0, channels=3)
    result = validator.validate(content, filename="multichannel.wav")

    assert not result.valid
    assert any("Unsupported channel count" in error for error in result.errors)


def test_file_exceeding_max_size_is_rejected() -> None:
    settings = Settings(_env_file=None, max_sample_file_size_mb=1)
    validator = AudioValidationService(settings)
    content = make_wav_bytes(duration_seconds=20.0, sample_rate=44100, channels=1)
    assert len(content) > 1 * 1024 * 1024

    result = validator.validate(content, filename="big.wav")

    assert not result.valid
    assert any("exceeds the maximum allowed size" in error for error in result.errors)
