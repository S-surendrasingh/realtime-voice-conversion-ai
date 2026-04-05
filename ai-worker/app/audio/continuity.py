import numpy as np


def equal_power_crossfade(tail: np.ndarray, head: np.ndarray, overlap: int) -> np.ndarray:
    """Blend `tail` (end of the previous chunk's output) into the start of
    `head` (the next chunk's output) over `overlap` samples using an
    equal-power (cosine) curve, so chunk boundaries don't click or dip in
    loudness the way a linear crossfade can. Returns `head` with its first
    `overlap` samples replaced by the blend; the rest of `head` is
    untouched. Mirrors the crossfade shape seed-vc's own inference.py uses.
    """
    overlap = min(overlap, len(tail), len(head))
    if overlap <= 0:
        return head
    fade_out = np.cos(np.linspace(0, np.pi / 2, overlap)) ** 2
    fade_in = np.cos(np.linspace(np.pi / 2, 0, overlap)) ** 2
    blended = head.copy()
    blended[:overlap] = head[:overlap] * fade_in + tail[-overlap:] * fade_out
    return blended


def stitch_chunks(chunk_outputs: list[np.ndarray], overlap_samples: int) -> np.ndarray:
    """Concatenate per-chunk converted audio into one continuous signal.
    Each chunk (see audio/chunking.py) shares `overlap_samples` of content
    with its neighbors at both edges; every boundary is blended exactly
    once via equal_power_crossfade, never duplicated.
    """
    if not chunk_outputs:
        return np.array([], dtype="float32")
    if len(chunk_outputs) == 1 or overlap_samples <= 0:
        return np.concatenate(chunk_outputs).astype("float32")

    first = chunk_outputs[0]
    body_end = max(len(first) - overlap_samples, 0)
    stitched = [first[:body_end]]
    previous_tail = first[body_end:]

    for chunk in chunk_outputs[1:]:
        head = equal_power_crossfade(previous_tail, chunk, overlap_samples)
        is_last = chunk is chunk_outputs[-1]
        if is_last:
            stitched.append(head)
        else:
            body_end = max(len(head) - overlap_samples, 0)
            stitched.append(head[:body_end])
            previous_tail = head[body_end:]

    return np.concatenate(stitched).astype("float32")
