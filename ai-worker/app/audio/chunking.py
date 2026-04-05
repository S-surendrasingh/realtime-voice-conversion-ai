"""Offline chunk-by-chunk conversion harness (Phase 3 Step 5). This proves
out VoiceConversionEngine.process_chunk() + the continuity/crossfade logic
end-to-end on a whole file, without needing a real streaming transport —
Phase 4 will drive the same process_chunk()/create_stream() calls from a
live microphone instead of this harness.
"""

import time
from pathlib import Path

import numpy as np

from app.audio.continuity import stitch_chunks
from app.engines.base import VoiceConversionEngine


def split_into_chunks(
    audio: np.ndarray, sample_rate: int, chunk_ms: int, overlap_ms: int
) -> list[np.ndarray]:
    """Splits `audio` into chunks of chunk_ms, each extended by overlap_ms
    of extra trailing context shared with the next chunk. Consecutive
    chunks therefore overlap by `overlap_samples` of raw input, which is
    what lets stitch_chunks() crossfade their converted output smoothly."""
    chunk_len = max(int(sample_rate * chunk_ms / 1000), 1)
    overlap_len = int(sample_rate * overlap_ms / 1000)
    chunks = []
    start = 0
    n = len(audio)
    while start < n:
        end = min(start + chunk_len + overlap_len, n)
        chunks.append(audio[start:end])
        if end >= n:
            break
        start += chunk_len
    return chunks


def convert_chunked(
    engine: VoiceConversionEngine,
    audio: np.ndarray,
    sample_rate: int,
    prepared_voice_path: Path,
    chunk_ms: int,
    overlap_ms: int,
) -> tuple[np.ndarray, list[float]]:
    """Returns (stitched_output_audio, per_chunk_latencies_seconds)."""
    overlap_samples = int(sample_rate * overlap_ms / 1000)
    chunks = split_into_chunks(audio, sample_rate, chunk_ms, overlap_ms)

    outputs: list[np.ndarray] = []
    latencies: list[float] = []
    for chunk in chunks:
        start = time.monotonic()
        outputs.append(engine.process_chunk(chunk, sample_rate, prepared_voice_path))
        latencies.append(time.monotonic() - start)

    stitched = stitch_chunks(outputs, overlap_samples)
    return stitched, latencies
