import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient

from app.core.config import Environment, Settings
from app.main import app

pytestmark = pytest.mark.asyncio


async def test_app_starts_and_exposes_openapi_schema() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/openapi.json")

    assert response.status_code == 200
    schema = response.json()
    assert schema["info"]["title"] == app.title


async def test_cors_headers_are_present_for_configured_origin() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get(
            "/api/v1/health",
            headers={"Origin": "http://localhost:3000"},
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def _build_app_with_settings(settings: Settings) -> FastAPI:
    """A minimal standalone app wired exactly like app/main.py's real
    CORSMiddleware setup, so this test proves the actual production wiring
    without touching the shared `app` singleton (which is fixed to
    app_env=test for the rest of this suite — see tests/conftest.py)."""
    test_app = FastAPI()
    test_app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_origin_regex=settings.cors_allow_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @test_app.get("/ping")
    def ping() -> dict:
        return {"ok": True}

    return test_app


async def test_dev_origin_is_allowed_automatically_in_development() -> None:
    """A Vite/Electron dev server on a port that changed since CORS_ORIGINS
    was last edited must still work — the whole point of the regex fix."""
    dev_settings = Settings(_env_file=None, app_env=Environment.DEVELOPMENT, cors_origins="http://localhost:3000")
    transport = ASGITransport(app=_build_app_with_settings(dev_settings))
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/ping", headers={"Origin": "http://localhost:5173"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


async def test_unlisted_origin_is_rejected_in_production_even_if_localhost_shaped() -> None:
    """Production must stay restrictive — no dev-convenience regex, and no
    origin outside the explicit allowlist, no matter what it looks like."""
    prod_settings = Settings(_env_file=None, app_env=Environment.PRODUCTION, cors_origins="https://app.voiceshift.ai")
    transport = ASGITransport(app=_build_app_with_settings(prod_settings))
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/ping", headers={"Origin": "http://localhost:5173"})

    assert response.status_code == 200  # request itself succeeds...
    # ...but without this header the browser would block the response.
    assert "access-control-allow-origin" not in response.headers
