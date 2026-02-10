from __future__ import annotations

from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path, PurePosixPath

from app.core.config import Settings, StorageBackend, get_settings


class StorageError(Exception):
    """Raised when a storage backend fails to save, read, or delete an object."""


class StorageService(ABC):
    """Abstraction over where voice sample audio bytes physically live. Callers
    only ever deal in storage keys — never filesystem paths or bucket details —
    so the backend can move from local disk to S3-compatible storage without any
    change to the voice enrollment services."""

    @abstractmethod
    def save(self, key: str, content: bytes) -> None: ...

    @abstractmethod
    def read(self, key: str) -> bytes: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...

    @abstractmethod
    def exists(self, key: str) -> bool: ...


def _normalize_key(key: str) -> PurePosixPath:
    """Reject any key that could escape the storage root (path traversal)."""
    normalized = PurePosixPath(key)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise StorageError(f"Unsafe storage key: {key!r}")
    return normalized


class LocalStorage(StorageService):
    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        path = (self._root / _normalize_key(key)).resolve()
        if self._root not in path.parents and path != self._root:
            raise StorageError(f"Unsafe storage key: {key!r}")
        return path

    def save(self, key: str, content: bytes) -> None:
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def read(self, key: str) -> bytes:
        try:
            return self._resolve(key).read_bytes()
        except FileNotFoundError as exc:
            raise StorageError(f"Object not found: {key!r}") from exc

    def delete(self, key: str) -> None:
        self._resolve(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self._resolve(key).is_file()


class S3Storage(StorageService):
    def __init__(self, *, bucket: str, region: str, endpoint_url: str | None = None) -> None:
        import boto3

        if not bucket:
            raise StorageError("STORAGE_S3_BUCKET must be set to use the S3 storage backend.")
        self._bucket = bucket
        self._client = boto3.client("s3", region_name=region, endpoint_url=endpoint_url)

    def save(self, key: str, content: bytes) -> None:
        _normalize_key(key)
        self._client.put_object(Bucket=self._bucket, Key=key, Body=content)

    def read(self, key: str) -> bytes:
        _normalize_key(key)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
            return response["Body"].read()
        except self._client.exceptions.NoSuchKey as exc:
            raise StorageError(f"Object not found: {key!r}") from exc

    def delete(self, key: str) -> None:
        _normalize_key(key)
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def exists(self, key: str) -> bool:
        _normalize_key(key)
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:
            return False


def build_storage_service(settings: Settings) -> StorageService:
    if settings.storage_backend is StorageBackend.S3:
        return S3Storage(
            bucket=settings.storage_s3_bucket,
            region=settings.storage_s3_region,
            endpoint_url=settings.storage_s3_endpoint_url,
        )
    return LocalStorage(settings.storage_local_root)


@lru_cache
def get_storage_service() -> StorageService:
    return build_storage_service(get_settings())
