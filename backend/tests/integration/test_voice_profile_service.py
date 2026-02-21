import uuid

import pytest

from app.core.config import Settings
from app.models.user import User
from app.models.voice_profile import VoiceProfileStatus
from app.models.voice_sample import VoiceSample, VoiceSampleStatus
from app.services import voice_profiles
from app.services.voice_profiles import (
    ConsentRequiredError,
    InsufficientValidSamplesError,
    InvalidProfileStateError,
)


@pytest.fixture
def user(db_session) -> User:
    user = User()
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None, min_valid_voice_samples=3)


def test_create_profile_requires_consent(db_session, user) -> None:
    with pytest.raises(ConsentRequiredError):
        voice_profiles.create_profile(
            db_session,
            user_id=user.id,
            name="Person A",
            description=None,
            consent_confirmed=False,
        )


def test_create_profile_with_consent_starts_recording(db_session, user) -> None:
    profile = voice_profiles.create_profile(
        db_session,
        user_id=user.id,
        name="Person A",
        description="Target voice",
        consent_confirmed=True,
    )

    assert profile.status is VoiceProfileStatus.RECORDING
    assert profile.consent_confirmed
    assert profile.consent_confirmed_at is not None


def test_get_profile_for_wrong_user_returns_none(db_session, user) -> None:
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )

    other_user_id = uuid.uuid4()
    result = voice_profiles.get_profile(db_session, profile_id=profile.id, user_id=other_user_id)
    assert result is None


def _add_sample(db_session, profile_id, status: VoiceSampleStatus) -> VoiceSample:
    sample = VoiceSample(
        voice_profile_id=profile_id,
        storage_key=f"key-{uuid.uuid4()}.wav",
        original_filename="sample.wav",
        mime_type="audio/wav",
        file_size=1024,
        duration_seconds=10.0,
        status=status,
    )
    db_session.add(sample)
    db_session.commit()
    return sample


def test_complete_enrollment_fails_with_insufficient_valid_samples(
    db_session, user, settings
) -> None:
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )
    _add_sample(db_session, profile.id, VoiceSampleStatus.VALID)
    _add_sample(db_session, profile.id, VoiceSampleStatus.INVALID)

    with pytest.raises(InsufficientValidSamplesError):
        voice_profiles.complete_enrollment(db_session, profile=profile, settings=settings)


def test_complete_enrollment_succeeds_with_enough_valid_samples(db_session, user, settings) -> None:
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )
    for _ in range(3):
        _add_sample(db_session, profile.id, VoiceSampleStatus.VALID)

    updated = voice_profiles.complete_enrollment(db_session, profile=profile, settings=settings)

    assert updated.status is VoiceProfileStatus.READY_FOR_AI_PROCESSING


def test_complete_enrollment_ignores_deleted_samples(db_session, user, settings) -> None:
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )
    for _ in range(3):
        _add_sample(db_session, profile.id, VoiceSampleStatus.VALID)
    _add_sample(db_session, profile.id, VoiceSampleStatus.DELETED)

    updated = voice_profiles.complete_enrollment(db_session, profile=profile, settings=settings)
    assert updated.status is VoiceProfileStatus.READY_FOR_AI_PROCESSING


def test_complete_enrollment_without_consent_is_rejected(db_session, user, settings) -> None:
    # Not reachable through the API (consent is mandatory at creation) — this
    # exercises the service-level guard directly as defense in depth.
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )
    profile.consent_confirmed = False
    for _ in range(3):
        _add_sample(db_session, profile.id, VoiceSampleStatus.VALID)

    with pytest.raises(ConsentRequiredError):
        voice_profiles.complete_enrollment(db_session, profile=profile, settings=settings)


def test_complete_enrollment_on_archived_profile_is_rejected(db_session, user, settings) -> None:
    profile = voice_profiles.create_profile(
        db_session, user_id=user.id, name="Person A", description=None, consent_confirmed=True
    )
    profile.status = VoiceProfileStatus.ARCHIVED
    for _ in range(3):
        _add_sample(db_session, profile.id, VoiceSampleStatus.VALID)

    with pytest.raises(InvalidProfileStateError):
        voice_profiles.complete_enrollment(db_session, profile=profile, settings=settings)
