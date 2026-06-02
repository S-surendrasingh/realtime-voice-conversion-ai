import numpy as np

from app.audio.preprocessing import load_mono, resample


def test_load_mono_returns_1d_array_and_sample_rate(make_wav):
    path = make_wav("mono.wav", duration_seconds=1.0, sample_rate=22050)
    audio, sr = load_mono(path)
    assert audio.ndim == 1
    assert sr == 22050
    assert len(audio) == 22050


def test_resample_is_noop_when_rates_match():
    audio = np.zeros(1000, dtype="float32")
    result = resample(audio, 22050, 22050)
    assert result is audio


def test_resample_changes_length_proportionally():
    audio = np.zeros(22050, dtype="float32")
    result = resample(audio, 22050, 16000)
    assert abs(len(result) - 16000) < 50
