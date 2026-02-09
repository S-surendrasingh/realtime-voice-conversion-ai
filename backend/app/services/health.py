from collections.abc import Callable
from dataclasses import dataclass, field

from app.core.config import get_settings
from app.db.session import check_database_connection
from app.services.conversion import ai_health_snapshot
from app.services.redis_client import check_redis_connection

_UNKNOWN_AI_HEALTH = {"configured": False, "device": "cpu", "model": "unknown", "loaded": None}


@dataclass(frozen=True)
class ReadinessResult:
    ready: bool
    database: bool
    redis: bool
    # Defaulted so callers that construct this directly without caring about
    # AI (e.g. tests/integration/test_health_endpoints.py, which predates
    # Phase 3) don't need to change — see AIHealthInfo for the real shape.
    ai: dict = field(default_factory=lambda: dict(_UNKNOWN_AI_HEALTH))


def get_liveness_status() -> dict[str, str]:
    """The process is up and able to handle requests. No dependency checks."""
    return {"status": "ok"}


def _default_ai_check() -> dict:
    return ai_health_snapshot(get_settings())


def get_readiness_status(
    *,
    database_check: Callable[[], bool] = check_database_connection,
    redis_check: Callable[[], bool] = check_redis_connection,
    ai_check: Callable[[], dict] = _default_ai_check,
) -> ReadinessResult:
    """The process is up AND its required infrastructure is reachable. AI is
    an optional feature (see AIHealthInfo) and never affects `ready` — a
    profile-completion/enrollment deployment with no AI worker configured is
    still a healthy deployment."""
    database_ok = database_check()
    redis_ok = redis_check()
    return ReadinessResult(
        ready=database_ok and redis_ok,
        database=database_ok,
        redis=redis_ok,
        ai=ai_check(),
    )
