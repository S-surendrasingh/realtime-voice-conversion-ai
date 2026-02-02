import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.voice_profile import VoiceProfile


def create(db: Session, profile: VoiceProfile) -> VoiceProfile:
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


def get(db: Session, profile_id: uuid.UUID) -> VoiceProfile | None:
    return db.get(VoiceProfile, profile_id)


def get_for_user(db: Session, profile_id: uuid.UUID, user_id: uuid.UUID) -> VoiceProfile | None:
    profile = db.get(VoiceProfile, profile_id)
    if profile is None or profile.user_id != user_id:
        return None
    return profile


def list_for_user(db: Session, user_id: uuid.UUID) -> list[VoiceProfile]:
    stmt = (
        select(VoiceProfile)
        .where(VoiceProfile.user_id == user_id)
        .order_by(VoiceProfile.created_at.desc())
    )
    return list(db.scalars(stmt))


def save(db: Session, profile: VoiceProfile) -> VoiceProfile:
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


def delete(db: Session, profile: VoiceProfile) -> None:
    db.delete(profile)
    db.commit()
