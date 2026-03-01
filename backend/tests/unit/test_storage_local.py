import pytest

from app.services.storage import LocalStorage, StorageError


@pytest.fixture
def storage(tmp_path):
    return LocalStorage(tmp_path)


def test_save_and_read_round_trip(storage) -> None:
    storage.save("voice-profiles/abc/samples/1.wav", b"hello audio")
    assert storage.read("voice-profiles/abc/samples/1.wav") == b"hello audio"


def test_exists_reflects_saved_state(storage) -> None:
    assert not storage.exists("missing.wav")
    storage.save("present.wav", b"data")
    assert storage.exists("present.wav")


def test_delete_removes_object(storage) -> None:
    storage.save("to-delete.wav", b"data")
    storage.delete("to-delete.wav")
    assert not storage.exists("to-delete.wav")


def test_delete_is_idempotent_for_missing_object(storage) -> None:
    storage.delete("never-existed.wav")  # must not raise


def test_read_missing_object_raises_storage_error(storage) -> None:
    with pytest.raises(StorageError):
        storage.read("missing.wav")


@pytest.mark.parametrize(
    "malicious_key",
    [
        "../../etc/passwd",
        "/etc/passwd",
        "voice-profiles/../../secrets.txt",
    ],
)
def test_path_traversal_keys_are_rejected(storage, malicious_key) -> None:
    with pytest.raises(StorageError):
        storage.save(malicious_key, b"data")
