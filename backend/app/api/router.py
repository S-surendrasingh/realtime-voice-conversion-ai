from fastapi import APIRouter

from app.api.routes import health, voice_samples, voices

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(voices.router)
api_router.include_router(voice_samples.router)

# Reserved for future phases — do not implement yet:
#   api_router.include_router(auth.router)
#   api_router.include_router(sessions.router)
#   api_router.include_router(conversion.router)
