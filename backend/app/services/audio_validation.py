import io
from dataclasses import dataclass, field

import soundfile as sf

from app.core.config import Settings

# libsndfile can only reliably decode these containers without extra codecs
# (e.g. ffmpeg/lame for mp3, m4a, webm) — see docs/architecture.md for why those
# are deferred rather than adding a heavier audio dependency in Phase 2.
SUPPORTED_MIME_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/flac",
    "audio/x-flac",
    "audio/ogg",
}
SUPPORTED_EXTENSIONS = {".wav", ".flac", ".ogg"}


FORMAT_TO_EXTENSION = {
    "WAV": "wav",
    "FLAC": "flac",
    "OGG": "ogg",
}


@dataclass(frozen=True)
class AudioValidationResult:
    valid: bool
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    format: str | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def storage_extension(self) -> str:
        return FORMAT_TO_EXTENSION.get(self.format or "", "bin")


class AudioValidationService:
    """Basic technical validation of uploaded voice samples. Intentionally does
    not perform any AI-based voice quality analysis — that belongs to a later
    phase."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def validate(self, content: bytes, *, filename: str) -> AudioValidationResult:
        errors: list[str] = []

        if not content:
            return AudioValidationResult(valid=False, errors=["Audio file is empty."])

        if len(content) > self._settings.max_sample_file_size_bytes:
            errors.append(
                "Audio file exceeds the maximum allowed size of "
                f"{self._settings.max_sample_file_size_mb} MB."
            )

        extension = _extension_of(filename)
        if extension not in SUPPORTED_EXTENSIONS:
            errors.append(
                f"Unsupported file extension {extension!r}. "
                f"Supported extensions: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
            )
            return AudioValidationResult(valid=False, errors=errors)

        try:
            with sf.SoundFile(io.BytesIO(content)) as audio_file:
                frames = len(audio_file)
                sample_rate = audio_file.samplerate
                channels = audio_file.channels
                audio_format = audio_file.format
        except Exception:
            errors.append("Audio file is corrupt or not a supported audio format.")
            return AudioValidationResult(valid=False, errors=errors)

        if frames == 0 or sample_rate == 0:
            errors.append("Audio file contains no audio data.")
            return AudioValidationResult(valid=False, errors=errors)

        duration_seconds = frames / sample_rate

        if duration_seconds < self._settings.min_sample_duration_seconds:
            errors.append(
                "Audio duration is shorter than the minimum allowed duration of "
                f"{self._settings.min_sample_duration_seconds} seconds."
            )
        if duration_seconds > self._settings.max_sample_duration_seconds:
            errors.append(
                "Audio duration exceeds the maximum allowed duration of "
                f"{self._settings.max_sample_duration_seconds} seconds."
            )
        if channels not in (1, 2):
            errors.append(f"Unsupported channel count: {channels}.")

        return AudioValidationResult(
            valid=not errors,
            duration_seconds=duration_seconds,
            sample_rate=sample_rate,
            channels=channels,
            format=audio_format,
            errors=errors,
        )


def _extension_of(filename: str) -> str:
    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
