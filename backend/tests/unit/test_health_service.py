from app.services.health import get_liveness_status, get_readiness_status


def test_liveness_status_is_always_ok() -> None:
    assert get_liveness_status() == {"status": "ok"}


def test_readiness_is_ready_when_all_dependencies_are_up() -> None:
    result = get_readiness_status(database_check=lambda: True, redis_check=lambda: True)
    assert result.ready
    assert result.database
    assert result.redis


def test_readiness_is_not_ready_when_database_is_down() -> None:
    result = get_readiness_status(database_check=lambda: False, redis_check=lambda: True)
    assert not result.ready
    assert not result.database
    assert result.redis


def test_readiness_is_not_ready_when_redis_is_down() -> None:
    result = get_readiness_status(database_check=lambda: True, redis_check=lambda: False)
    assert not result.ready
    assert result.database
    assert not result.redis


def test_readiness_is_not_ready_when_both_dependencies_are_down() -> None:
    result = get_readiness_status(database_check=lambda: False, redis_check=lambda: False)
    assert not result.ready
