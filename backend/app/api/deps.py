import uuid

from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.user import User
from app.repositories import user_repository
from app.services.audio_validation import AudioValidationService

# Fixed development user — Phase 2 has no authentication. A later phase can
# replace this dependency with real auth-derived user extraction without
# touching the voice enrollment services, which only ever deal in a user_id.
DEV_USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


def get_current_user(db: Session = Depends(get_db)) -> User:
    return user_repository.get_or_create(db, DEV_USER_ID)


def get_audio_validation_service(
    settings: Settings = Depends(get_settings),
) -> AudioValidationService:
    return AudioValidationService(settings)
