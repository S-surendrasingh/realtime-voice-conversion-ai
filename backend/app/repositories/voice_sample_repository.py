import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.voice_sample import VoiceSample, VoiceSampleStatus


def create(db: Session, sample: VoiceSample) -> VoiceSample:
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return sample


def get(db: Session, sample_id: uuid.UUID) -> VoiceSample | None:
    return db.get(VoiceSample, sample_id)


def get_for_profile(
    db: Session, sample_id: uuid.UUID, voice_profile_id: uuid.UUID
) -> VoiceSample | None:
    sample = db.get(VoiceSample, sample_id)
    if sample is None or sample.voice_profile_id != voice_profile_id:
        return None
    return sample


def list_for_profile(
    db: Session, voice_profile_id: uuid.UUID, *, include_deleted: bool = False
) -> list[VoiceSample]:
    stmt = select(VoiceSample).where(VoiceSample.voice_profile_id == voice_profile_id)
    if not include_deleted:
        stmt = stmt.where(VoiceSample.status != VoiceSampleStatus.DELETED)
    stmt = stmt.order_by(VoiceSample.created_at)
    return list(db.scalars(stmt))


def count_valid_for_profile(db: Session, voice_profile_id: uuid.UUID) -> int:
    samples = list_for_profile(db, voice_profile_id)
    return sum(1 for sample in samples if sample.status == VoiceSampleStatus.VALID)


def save(db: Session, sample: VoiceSample) -> VoiceSample:
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return sample
