from enum import StrEnum
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[3]


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class StorageBackend(StrEnum):
    LOCAL = "local"
    S3 = "s3"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: Environment = Environment.DEVELOPMENT
    app_name: str = "Realtime AI Voice Conversion API"

    database_url: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/voice_conversion"
    redis_url: str = "redis://localhost:6379/0"

    secret_key: str = "change-me-in-production"
    cors_origins: str = "http://localhost:3000"

    # --- Voice sample storage ---
    storage_backend: StorageBackend = StorageBackend.LOCAL
    storage_local_root: str = "./storage"
    storage_s3_bucket: str = ""
    storage_s3_region: str = "us-east-1"
    storage_s3_endpoint_url: str | None = None

    # --- Voice sample validation limits (Phase 2) ---
    min_sample_duration_seconds: float = 3.0
    max_sample_duration_seconds: float = 60.0
    max_sample_file_size_mb: int = 25
    min_valid_voice_samples: int = 3

    # --- AI voice conversion (Phase 3) ---
    # The AI worker is a separate Python runtime/package (see ai-worker/),
    # invoked as a subprocess per request rather than imported — see
    # docs/phase3-ai-conversion.md "Why a subprocess, not a resident
    # service". These defaults resolve to the sibling ai-worker/ directory
    # for local (non-Docker) development, which is the only path this
    # phase actually exercises — see that doc's "Known Limitations" for
    # why the Dockerized backend does not yet have ai-worker access.
    ai_engine: str = "seed_vc"
    ai_worker_dir: str = str(_REPO_ROOT / "ai-worker")
    ai_worker_python: str = ""  # "" => <ai_worker_dir>/.venv/bin/python
    ai_conversion_timeout_seconds: float = 600.0

    @property
    def ai_worker_python_path(self) -> str:
        return self.ai_worker_python or str(Path(self.ai_worker_dir) / ".venv" / "bin" / "python")

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def cors_allow_origin_regex(self) -> str | None:
        """Development convenience only: matches any http(s)://localhost or
        127.0.0.1 origin on any port, so a Vite/Electron dev server picking
        a different port each run never requires hand-editing CORS_ORIGINS.
        Returns None outside development — production CORS must stay
        restricted to the explicit cors_origins_list, never a wildcard-style
        pattern combined with allow_credentials=True."""
        if self.app_env is not Environment.DEVELOPMENT:
            return None
        return r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

    @property
    def max_sample_file_size_bytes(self) -> int:
        return self.max_sample_file_size_mb * 1024 * 1024

    @property
    def is_production(self) -> bool:
        return self.app_env is Environment.PRODUCTION

    @property
    def is_test(self) -> bool:
        return self.app_env is Environment.TEST


@lru_cache
def get_settings() -> Settings:
    return Settings()
