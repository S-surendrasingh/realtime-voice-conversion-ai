import io
import wave


def make_wav_bytes(
    *, duration_seconds: float, sample_rate: int = 44100, channels: int = 1
) -> bytes:
    num_frames = int(duration_seconds * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * num_frames * channels)
    return buffer.getvalue()
