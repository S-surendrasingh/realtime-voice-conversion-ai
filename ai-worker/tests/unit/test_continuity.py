import numpy as np

from app.audio.continuity import equal_power_crossfade, stitch_chunks


def test_crossfade_output_length_matches_head():
    tail = np.ones(50, dtype="float32")
    head = np.zeros(100, dtype="float32")
    blended = equal_power_crossfade(tail, head, overlap=20)
    assert len(blended) == len(head)


def test_crossfade_smooths_a_step_discontinuity():
    tail = np.ones(50, dtype="float32")
    head = np.zeros(100, dtype="float32")
    blended = equal_power_crossfade(tail, head, overlap=20)
    # Immediately after the boundary, blended value should be between 0 and 1,
    # not an abrupt jump straight to 0.
    assert 0.0 < blended[0] <= 1.0
    assert blended[19] < blended[0]  # fades toward the new chunk's value


def test_crossfade_handles_overlap_larger_than_inputs():
    tail = np.ones(5, dtype="float32")
    head = np.zeros(3, dtype="float32")
    blended = equal_power_crossfade(tail, head, overlap=20)
    assert len(blended) == 3


def test_stitch_chunks_empty_list():
    assert stitch_chunks([], overlap_samples=10).size == 0


def test_stitch_chunks_single_chunk_returned_unchanged():
    chunk = np.arange(10, dtype="float32")
    result = stitch_chunks([chunk], overlap_samples=5)
    assert np.array_equal(result, chunk)


def test_stitch_chunks_preserves_approximate_total_length():
    # Each chunk is 100 samples, consecutive chunks share 20 samples of
    # overlap -> 5 chunks of pure non-overlapping content is 80*5=400 plus
    # one final full overlap tail.
    overlap = 20
    chunks = [np.full(100, float(i), dtype="float32") for i in range(5)]
    stitched = stitch_chunks(chunks, overlap_samples=overlap)
    expected_len = 100 + 4 * (100 - overlap)
    assert len(stitched) == expected_len


def test_stitch_chunks_produces_no_nan_or_inf():
    chunks = [np.random.default_rng(i).standard_normal(50).astype("float32") for i in range(4)]
    stitched = stitch_chunks(chunks, overlap_samples=10)
    assert np.isfinite(stitched).all()
