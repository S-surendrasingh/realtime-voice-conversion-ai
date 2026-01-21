from fastapi import APIRouter, Response, status

from app.schemas.health import AIHealthInfo, HealthResponse, ReadinessResponse
from app.services.health import get_liveness_status, get_readiness_status

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/live", response_model=HealthResponse)
def live() -> HealthResponse:
    return HealthResponse(**get_liveness_status())


@router.get("/ready", response_model=ReadinessResponse)
def ready(response: Response) -> ReadinessResponse:
    result = get_readiness_status()
    if not result.ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ok" if result.ready else "unavailable",
        database="ok" if result.database else "unavailable",
        redis="ok" if result.redis else "unavailable",
        ai=AIHealthInfo(**result.ai),
    )
