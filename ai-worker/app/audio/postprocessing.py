from pathlib import Path

import numpy as np
import soundfile as sf

from app.core.errors import AIEngineError, AIErrorCode

SILENCE_RMS_THRESHOLD = 1e-4


def validate_output(audio: np.ndarray, sample_rate: int) -> None:
    """The "did the model produce garbage" check requested for offline
    output validation — never a neural-quality check, only sanity: no NaN,
    no Inf, in-range amplitudes, not pure silence, a real sample rate.
    """
    if audio.size == 0:
        raise AIEngineError(AIErrorCode.INVALID_MODEL_OUTPUT, "Model produced zero-length audio")
    if not np.isfinite(audio).all():
        raise AIEngineError(AIErrorCode.INVALID_MODEL_OUTPUT, "Model output contains NaN/Inf samples")
    if np.max(np.abs(audio)) > 1.5:
        raise AIEngineError(AIErrorCode.INVALID_MODEL_OUTPUT, "Model output amplitude out of range")
    rms = float(np.sqrt(np.mean(np.square(audio))))
    if rms < SILENCE_RMS_THRESHOLD:
        raise AIEngineError(AIErrorCode.INVALID_MODEL_OUTPUT, "Model output is effectively silent")
    if sample_rate <= 0:
        raise AIEngineError(AIErrorCode.INVALID_MODEL_OUTPUT, f"Invalid output sample rate {sample_rate}")


def write_wav(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    validate_output(audio, sample_rate)
    peak = float(np.max(np.abs(audio)))
    if peak > 1.0:
        audio = audio / peak  # defensive clip-prevention only; never silently boosts quiet output
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sample_rate, subtype="PCM_16")
