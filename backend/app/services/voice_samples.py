import re
import uuid
from pathlib import PurePosixPath

from sqlalchemy.orm import Session

from app.models.voice_profile import VoiceProfile
from app.models.voice_sample import VoiceSample, VoiceSampleStatus
from app.repositories import voice_sample_repository
from app.services.audio_validation import AudioValidationService
from app.services.storage import StorageService


def upload_sample(
    db: Session,
    *,
    profile: VoiceProfile,
    content: bytes,
    original_filename: str,
    declared_mime_type: str,
    validator: AudioValidationService,
    storage: StorageService,
) -> VoiceSample:
    result = validator.validate(content, filename=original_filename)

    sample_id = uuid.uuid4()
    storage_key = f"voice-profiles/{profile.id}/samples/{sample_id}.{result.storage_extension}"
    storage.save(storage_key, content)

    sample = VoiceSample(
        id=sample_id,
        voice_profile_id=profile.id,
        storage_key=storage_key,
        original_filename=_safe_display_filename(original_filename),
        mime_type=declared_mime_type,
        file_size=len(content),
        duration_seconds=result.duration_seconds,
        sample_rate=result.sample_rate,
        channels=result.channels,
        status=VoiceSampleStatus.VALID if result.valid else VoiceSampleStatus.INVALID,
        validation_error="; ".join(result.errors) if result.errors else None,
    )
    return voice_sample_repository.create(db, sample)


def list_samples(db: Session, *, voice_profile_id: uuid.UUID) -> list[VoiceSample]:
    return voice_sample_repository.list_for_profile(db, voice_profile_id)


def get_sample(
    db: Session, *, sample_id: uuid.UUID, voice_profile_id: uuid.UUID
) -> VoiceSample | None:
    sample = voice_sample_repository.get_for_profile(db, sample_id, voice_profile_id)
    if sample is None or sample.status is VoiceSampleStatus.DELETED:
        return None
    return sample


def delete_sample(db: Session, *, sample: VoiceSample, storage: StorageService) -> None:
    storage.delete(sample.storage_key)
    sample.status = VoiceSampleStatus.DELETED
    voice_sample_repository.save(db, sample)


def _safe_display_filename(filename: str) -> str:
    name = PurePosixPath(filename).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name[:255] or "sample"
