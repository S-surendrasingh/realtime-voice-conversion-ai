from app.core.config import Environment, Settings


def test_default_environment_is_development(monkeypatch) -> None:
    # The test suite itself runs with APP_ENV=test (see tests/conftest.py) so
    # tests never touch the development database. Clear it here to test the
    # field's actual default, independent of that ambient environment.
    monkeypatch.delenv("APP_ENV", raising=False)
    settings = Settings(_env_file=None)
    assert settings.app_env is Environment.DEVELOPMENT
    assert not settings.is_production
    assert not settings.is_test


def test_production_environment_flags() -> None:
    settings = Settings(_env_file=None, app_env=Environment.PRODUCTION)
    assert settings.is_production
    assert not settings.is_test


def test_cors_origins_list_parses_comma_separated_values() -> None:
    settings = Settings(_env_file=None, cors_origins="http://a.com, http://b.com,,")
    assert settings.cors_origins_list == ["http://a.com", "http://b.com"]


def test_cors_origins_list_empty_string_yields_empty_list() -> None:
    settings = Settings(_env_file=None, cors_origins="")
    assert settings.cors_origins_list == []


def test_cors_allow_origin_regex_matches_localhost_and_127_on_any_port() -> None:
    import re

    settings = Settings(_env_file=None, app_env=Environment.DEVELOPMENT)
    assert settings.cors_allow_origin_regex is not None
    pattern = re.compile(settings.cors_allow_origin_regex)
    assert pattern.match("http://localhost:5173")
    assert pattern.match("http://127.0.0.1:3000")
    assert pattern.match("http://localhost")  # no port
    assert not pattern.match("http://evil.com")
    assert not pattern.match("http://localhost.evil.com:5173")


def test_cors_allow_origin_regex_is_none_outside_development() -> None:
    assert Settings(_env_file=None, app_env=Environment.PRODUCTION).cors_allow_origin_regex is None
    assert Settings(_env_file=None, app_env=Environment.TEST).cors_allow_origin_regex is None
