from unittest.mock import MagicMock, patch

from app.db.session import check_database_connection


def test_check_database_connection_returns_true_when_query_succeeds() -> None:
    fake_connection = MagicMock()
    fake_engine = MagicMock()
    fake_engine.connect.return_value.__enter__.return_value = fake_connection
    with patch("app.db.session.engine", fake_engine):
        assert check_database_connection() is True
    fake_connection.execute.assert_called_once()


def test_check_database_connection_returns_false_when_connection_raises() -> None:
    fake_engine = MagicMock()
    fake_engine.connect.side_effect = ConnectionError("unreachable")
    with patch("app.db.session.engine", fake_engine):
        assert check_database_connection() is False
