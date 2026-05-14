import numpy as np

from app.audio.chunking import convert_chunked, split_into_chunks
from app.engines.passthrough import PassthroughVoiceEngine


def test_split_into_chunks_covers_full_signal_with_overlap():
    audio = np.arange(1000, dtype="float32")
    chunks = split_into_chunks(audio, sample_rate=1000, chunk_ms=100, overlap_ms=20)
    # chunk_len=100 samples, overlap=20 samples -> chunks of up to 120 samples, hop 100
    assert len(chunks) == 10
    assert all(len(c) <= 120 for c in chunks)


def test_split_into_chunks_handles_short_audio():
    audio = np.arange(50, dtype="float32")
    chunks = split_into_chunks(audio, sample_rate=1000, chunk_ms=100, overlap_ms=20)
    assert len(chunks) == 1
    assert len(chunks[0]) == 50


def test_split_into_chunks_zero_overlap_is_exact_partition():
    audio = np.arange(300, dtype="float32")
    chunks = split_into_chunks(audio, sample_rate=1000, chunk_ms=100, overlap_ms=0)
    assert sum(len(c) for c in chunks) == 300
    assert np.concatenate(chunks).tolist() == audio.tolist()


def test_convert_chunked_with_passthrough_preserves_duration(settings, tmp_path):
    engine = PassthroughVoiceEngine(settings)
    engine.load()
    audio = np.random.default_rng(0).standard_normal(22050 * 2).astype("float32") * 0.1
    stitched, latencies = convert_chunked(
        engine, audio, 22050, tmp_path / "unused.json", chunk_ms=300, overlap_ms=40
    )
    assert len(latencies) > 0
    # stitching should not massively change total duration (within one chunk's worth)
    assert abs(len(stitched) - len(audio)) < 22050 * 0.5
