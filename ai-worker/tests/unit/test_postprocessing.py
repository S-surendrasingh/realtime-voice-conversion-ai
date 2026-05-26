import numpy as np
import pytest

from app.audio.postprocessing import validate_output, write_wav
from app.core.errors import AIEngineError


def test_validate_output_accepts_normal_audio():
    audio = 0.3 * np.sin(np.linspace(0, 100, 22050)).astype("float32")
    validate_output(audio, 22050)  # must not raise


def test_validate_output_rejects_nan():
    audio = np.full(1000, np.nan, dtype="float32")
    with pytest.raises(AIEngineError) as exc_info:
        validate_output(audio, 22050)
    assert exc_info.value.code.value == "INVALID_MODEL_OUTPUT"


def test_validate_output_rejects_inf():
    audio = np.full(1000, np.inf, dtype="float32")
    with pytest.raises(AIEngineError):
        validate_output(audio, 22050)


def test_validate_output_rejects_silence():
    audio = np.zeros(1000, dtype="float32")
    with pytest.raises(AIEngineError) as exc_info:
        validate_output(audio, 22050)
    assert exc_info.value.code.value == "INVALID_MODEL_OUTPUT"


def test_validate_output_rejects_empty():
    with pytest.raises(AIEngineError):
        validate_output(np.array([], dtype="float32"), 22050)


def test_validate_output_rejects_out_of_range_amplitude():
    audio = np.full(1000, 5.0, dtype="float32")
    with pytest.raises(AIEngineError):
        validate_output(audio, 22050)


def test_validate_output_rejects_invalid_sample_rate():
    audio = 0.3 * np.sin(np.linspace(0, 100, 1000)).astype("float32")
    with pytest.raises(AIEngineError):
        validate_output(audio, 0)


def test_write_wav_produces_readable_file(tmp_path):
    import soundfile as sf

    audio = 0.3 * np.sin(np.linspace(0, 100, 22050)).astype("float32")
    path = tmp_path / "out.wav"
    write_wav(path, audio, 22050)
    assert path.exists()
    read_back, sr = sf.read(path)
    assert sr == 22050
    assert len(read_back) == len(audio)
