from functools import lru_cache

import redis

from app.core.config import get_settings


@lru_cache
def get_redis_client() -> redis.Redis:
    settings = get_settings()
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def check_redis_connection() -> bool:
    """Used by the readiness endpoint to verify Redis is reachable."""
    try:
        return bool(get_redis_client().ping())
    except Exception:
        return False
