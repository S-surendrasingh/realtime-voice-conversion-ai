import numpy as np
import pytest
import soundfile as sf

from app.core.config import Settings


@pytest.fixture
def make_wav(tmp_path):
    """Synthetic speech-shaped (not silent, not pure sine) mono WAV, matching
    the backend test suite's own approach of never using real recordings for
    plain unit tests."""

    def _make(
        name: str = "audio.wav", duration_seconds: float = 2.0, sample_rate: int = 22050, seed: int = 0
    ):
        rng = np.random.default_rng(seed)
        t = np.linspace(0, duration_seconds, int(sample_rate * duration_seconds), endpoint=False)
        tone = 0.2 * np.sin(2 * np.pi * 180 * t)
        noise = 0.02 * rng.standard_normal(t.shape)
        audio = (tone + noise).astype("float32")
        path = tmp_path / name
        sf.write(path, audio, sample_rate)
        return path

    return _make


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None)
