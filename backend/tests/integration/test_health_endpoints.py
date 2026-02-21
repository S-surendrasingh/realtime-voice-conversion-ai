from unittest.mock import patch

import pytest

from app.services.health import ReadinessResult

pytestmark = pytest.mark.asyncio


async def test_health_endpoint_returns_ok(client) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_live_endpoint_returns_ok(client) -> None:
    response = await client.get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_ready_endpoint_returns_200_when_dependencies_are_up(client) -> None:
    with patch("app.api.routes.health.get_readiness_status") as mock_status:
        mock_status.return_value = ReadinessResult(ready=True, database=True, redis=True)
        response = await client.get("/api/v1/health/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
    assert body["redis"] == "ok"
    assert "ai" in body  # Phase 3 addition — see AIHealthInfo; never gates readiness


async def test_ready_endpoint_returns_503_when_a_dependency_is_down(client) -> None:
    with patch("app.api.routes.health.get_readiness_status") as mock_status:
        mock_status.return_value = ReadinessResult(ready=False, database=False, redis=True)
        response = await client.get("/api/v1/health/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["database"] == "unavailable"
    assert body["redis"] == "ok"
