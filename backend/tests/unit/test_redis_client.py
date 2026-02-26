from unittest.mock import MagicMock, patch

from app.services.redis_client import check_redis_connection, get_redis_client


def test_get_redis_client_returns_cached_instance() -> None:
    get_redis_client.cache_clear()
    first = get_redis_client()
    second = get_redis_client()
    assert first is second
    get_redis_client.cache_clear()


def test_check_redis_connection_returns_true_when_ping_succeeds() -> None:
    fake_client = MagicMock()
    fake_client.ping.return_value = True
    with patch("app.services.redis_client.get_redis_client", return_value=fake_client):
        assert check_redis_connection() is True


def test_check_redis_connection_returns_false_when_ping_raises() -> None:
    fake_client = MagicMock()
    fake_client.ping.side_effect = ConnectionError("unreachable")
    with patch("app.services.redis_client.get_redis_client", return_value=fake_client):
        assert check_redis_connection() is False
