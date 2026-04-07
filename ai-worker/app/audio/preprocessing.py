from pathlib import Path

import numpy as np
import soundfile as sf


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    """Decode any supported file to a 1-D float32 mono array at its native
    sample rate. Resampling to a model's required rate is the engine's own
    job (it knows what rate it needs) — this function only normalizes
    channel count, since every engine needs mono either way.
    """
    audio, sample_rate = sf.read(str(path), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, sample_rate


def resample(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr:
        return audio
    import librosa

    return librosa.resample(audio, orig_sr=orig_sr, target_sr=target_sr).astype("float32")
