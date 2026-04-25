import hashlib
from pathlib import Path


def hash_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            hasher.update(block)
    return hasher.hexdigest()[:16]


def compute_cache_key(
    voice_profile_id: str,
    engine_name: str,
    model_version: str,
    reference_hashes: list[str],
) -> str:
    """Identifies one (profile, engine, model, exact reference set) tuple.
    A cached prepared-voice artifact is valid exactly as long as this key
    is unchanged; any edit to the reference samples (add/remove/replace)
    changes at least one hash and therefore the whole key, which is how
    "stale cache" invalidation works — there is no separate invalidation
    flag to maintain, the key simply stops matching.
    """
    payload = "|".join([voice_profile_id, engine_name, model_version, *sorted(reference_hashes)])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
