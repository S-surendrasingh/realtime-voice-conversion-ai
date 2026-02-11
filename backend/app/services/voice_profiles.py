import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.voice_profile import VoiceProfile, VoiceProfileStatus
from app.repositories import voice_profile_repository, voice_sample_repository
from app.services.conversion import derived_cache_keys
from app.services.errors import DomainError
from app.services.storage import StorageService


class ConsentRequiredError(DomainError):
    def __init__(self) -> None:
        super().__init__("Consent must be confirmed to create or complete a voice profile.")


class InsufficientValidSamplesError(DomainError):
    def __init__(self, required: int, actual: int) -> None:
        super().__init__(
            f"At least {required} valid voice samples are required to complete "
            f"enrollment (currently {actual})."
        )


class InvalidProfileStateError(DomainError):
    pass


def create_profile(
    db: Session,
    *,
    user_id: uuid.UUID,
    name: str,
    description: str | None,
    consent_confirmed: bool,
) -> VoiceProfile:
    if not consent_confirmed:
        raise ConsentRequiredError

    now = datetime.now(UTC)
    profile = VoiceProfile(
        user_id=user_id,
        name=name,
        description=description,
        status=VoiceProfileStatus.RECORDING,
        consent_confirmed=True,
        consent_confirmed_at=now,
    )
    return voice_profile_repository.create(db, profile)


def list_profiles(db: Session, *, user_id: uuid.UUID) -> list[VoiceProfile]:
    return voice_profile_repository.list_for_user(db, user_id)


def get_profile(db: Session, *, profile_id: uuid.UUID, user_id: uuid.UUID) -> VoiceProfile | None:
    return voice_profile_repository.get_for_user(db, profile_id, user_id)


def update_profile(
    db: Session,
    *,
    profile: VoiceProfile,
    name: str | None,
    description: str | None,
) -> VoiceProfile:
    if name is not None:
        profile.name = name
    if description is not None:
        profile.description = description
    return voice_profile_repository.save(db, profile)


def delete_profile(
    db: Session, *, profile: VoiceProfile, storage: StorageService, settings: Settings
) -> None:
    for sample in voice_sample_repository.list_for_profile(db, profile.id, include_deleted=True):
        storage.delete(sample.storage_key)
    # Best-effort: only the deterministically-keyed prepared-voice cache can
    # be cleaned up without a storage "list by prefix" capability; individual
    # conversion outputs (random ids) are not — see conversion.py's
    # derived_cache_keys() docstring.
    for key in derived_cache_keys(profile.id, settings.ai_engine):
        storage.delete(key)
    voice_profile_repository.delete(db, profile)


def complete_enrollment(db: Session, *, profile: VoiceProfile, settings: Settings) -> VoiceProfile:
    if profile.status is VoiceProfileStatus.ARCHIVED:
        raise InvalidProfileStateError("Cannot complete an archived voice profile.")
    if not profile.consent_confirmed:
        raise ConsentRequiredError

    valid_count = voice_sample_repository.count_valid_for_profile(db, profile.id)
    if valid_count < settings.min_valid_voice_samples:
        raise InsufficientValidSamplesError(settings.min_valid_voice_samples, valid_count)

    profile.status = VoiceProfileStatus.READY_FOR_AI_PROCESSING
    return voice_profile_repository.save(db, profile)
