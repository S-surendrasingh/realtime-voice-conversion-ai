from unittest.mock import MagicMock, patch

import pytest

from app.services.storage import S3Storage, StorageError


def make_s3_storage(mock_client: MagicMock) -> S3Storage:
    with patch("boto3.client", return_value=mock_client):
        return S3Storage(bucket="test-bucket", region="us-east-1")


def test_save_puts_object_with_bucket_and_key() -> None:
    mock_client = MagicMock()
    storage = make_s3_storage(mock_client)

    storage.save("voice-profiles/abc/samples/1.wav", b"hello audio")

    mock_client.put_object.assert_called_once_with(
        Bucket="test-bucket", Key="voice-profiles/abc/samples/1.wav", Body=b"hello audio"
    )


def test_read_returns_object_body() -> None:
    mock_client = MagicMock()
    mock_client.get_object.return_value = {"Body": MagicMock(read=lambda: b"content")}
    storage = make_s3_storage(mock_client)

    assert storage.read("key.wav") == b"content"


def test_delete_calls_delete_object() -> None:
    mock_client = MagicMock()
    storage = make_s3_storage(mock_client)

    storage.delete("key.wav")

    mock_client.delete_object.assert_called_once_with(Bucket="test-bucket", Key="key.wav")


def test_exists_true_when_head_object_succeeds() -> None:
    mock_client = MagicMock()
    storage = make_s3_storage(mock_client)

    assert storage.exists("key.wav") is True


def test_exists_false_when_head_object_raises() -> None:
    mock_client = MagicMock()
    mock_client.head_object.side_effect = Exception("not found")
    storage = make_s3_storage(mock_client)

    assert storage.exists("key.wav") is False


def test_missing_bucket_raises_storage_error() -> None:
    with pytest.raises(StorageError):
        S3Storage(bucket="", region="us-east-1")


def test_path_traversal_key_is_rejected() -> None:
    mock_client = MagicMock()
    storage = make_s3_storage(mock_client)

    with pytest.raises(StorageError):
        storage.save("../escape.wav", b"data")
