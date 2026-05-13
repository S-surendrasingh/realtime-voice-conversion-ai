from app.voices.cache import compute_cache_key, hash_file


def test_hash_file_is_deterministic(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"hello world")
    assert hash_file(f) == hash_file(f)


def test_hash_file_differs_for_different_content(tmp_path):
    f1 = tmp_path / "a.bin"
    f2 = tmp_path / "b.bin"
    f1.write_bytes(b"hello")
    f2.write_bytes(b"world")
    assert hash_file(f1) != hash_file(f2)


def test_cache_key_stable_for_same_inputs():
    key1 = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-a", "hash-b"])
    key2 = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-b", "hash-a"])  # order-independent
    assert key1 == key2


def test_cache_key_changes_when_reference_hashes_change():
    key1 = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-a"])
    key2 = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-a", "hash-b"])
    assert key1 != key2


def test_cache_key_changes_when_engine_or_model_changes():
    base = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-a"])
    diff_engine = compute_cache_key("profile-1", "passthrough", "v1", ["hash-a"])
    diff_model = compute_cache_key("profile-1", "seed_vc", "v2", ["hash-a"])
    assert base != diff_engine
    assert base != diff_model


def test_cache_key_changes_when_profile_changes():
    key1 = compute_cache_key("profile-1", "seed_vc", "v1", ["hash-a"])
    key2 = compute_cache_key("profile-2", "seed_vc", "v1", ["hash-a"])
    assert key1 != key2
