from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str


class AIHealthInfo(BaseModel):
    """Never gates readiness (see get_readiness_status) — AI is an optional
    feature, not required infrastructure. `loaded` is None until at least
    one conversion has been attempted in this process's lifetime; Phase 3
    has no resident engine to query, only the outcome of the last attempt."""

    configured: bool
    device: str
    model: str
    loaded: bool | None


class ReadinessResponse(BaseModel):
    status: str
    database: str
    redis: str
    ai: AIHealthInfo
