"""Input-audio validation for the AI worker. Deliberately independent of
backend/app/services/audio_validation.py — the two services run in separate
Python environments with no shared import path — but follows the same
soundfile-based, extension-gated approach for consistency.
"""

from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from app.core.errors import AIEngineError, AIErrorCode

SUPPORTED_EXTENSIONS = {".wav", ".flac", ".ogg"}
MIN_DURATION_SECONDS = 0.5
MAX_DURATION_SECONDS = 300.0


@dataclass
class AudioInfo:
    path: Path
    duration_seconds: float
    sample_rate: int
    channels: int


def validate_and_inspect(path: Path) -> AudioInfo:
    """Raises AIEngineError(SOURCE_AUDIO_INVALID) with a clear reason on any
    problem; otherwise returns the decoded audio's basic properties."""
    if not path.exists() or path.stat().st_size == 0:
        raise AIEngineError(AIErrorCode.SOURCE_AUDIO_INVALID, f"{path} is missing or empty")
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise AIEngineError(
            AIErrorCode.SOURCE_AUDIO_INVALID,
            f"Unsupported extension {path.suffix!r}; expected one of {sorted(SUPPORTED_EXTENSIONS)}",
        )
    try:
        with sf.SoundFile(str(path)) as f:
            frames, sample_rate, channels = f.frames, f.samplerate, f.channels
    except Exception as exc:
        raise AIEngineError(
            AIErrorCode.SOURCE_AUDIO_INVALID, f"{path} is not a decodable audio file"
        ) from exc

    if frames == 0 or sample_rate == 0:
        raise AIEngineError(AIErrorCode.SOURCE_AUDIO_INVALID, f"{path} has no audio data")

    duration = frames / sample_rate
    if not (MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS):
        raise AIEngineError(
            AIErrorCode.SOURCE_AUDIO_INVALID,
            f"{path} duration {duration:.2f}s outside [{MIN_DURATION_SECONDS}, {MAX_DURATION_SECONDS}]s",
        )
    return AudioInfo(path=path, duration_seconds=duration, sample_rate=sample_rate, channels=channels)
