import uuid

from app.models.user import User
from app.models.voice_profile import VoiceProfile, VoiceProfileStatus
from app.models.voice_sample import VoiceSample, VoiceSampleStatus


def test_user_creation(db_session) -> None:
    user = User()
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    assert isinstance(user.id, uuid.UUID)
    assert user.created_at is not None
    assert user.updated_at is not None


def test_voice_profile_creation_and_user_relationship(db_session) -> None:
    user = User()
    db_session.add(user)
    db_session.commit()

    profile = VoiceProfile(
        user_id=user.id,
        name="Person A",
        description="My target voice",
        status=VoiceProfileStatus.RECORDING,
        consent_confirmed=True,
    )
    db_session.add(profile)
    db_session.commit()
    db_session.refresh(profile)

    assert profile.status is VoiceProfileStatus.RECORDING
    assert profile.user_id == user.id


def test_voice_sample_relationship_to_profile(db_session) -> None:
    user = User()
    db_session.add(user)
    db_session.commit()

    profile = VoiceProfile(user_id=user.id, name="Person A", consent_confirmed=True)
    db_session.add(profile)
    db_session.commit()

    sample = VoiceSample(
        voice_profile_id=profile.id,
        storage_key=f"voice-profiles/{profile.id}/samples/1.wav",
        original_filename="sample.wav",
        mime_type="audio/wav",
        file_size=1024,
        status=VoiceSampleStatus.VALID,
    )
    db_session.add(sample)
    db_session.commit()
    db_session.refresh(profile)

    assert len(profile.samples) == 1
    assert profile.samples[0].id == sample.id


def test_deleting_profile_cascades_to_samples(db_session) -> None:
    user = User()
    db_session.add(user)
    db_session.commit()

    profile = VoiceProfile(user_id=user.id, name="Person A", consent_confirmed=True)
    db_session.add(profile)
    db_session.commit()

    sample = VoiceSample(
        voice_profile_id=profile.id,
        storage_key="key.wav",
        original_filename="sample.wav",
        mime_type="audio/wav",
        file_size=1024,
        status=VoiceSampleStatus.VALID,
    )
    db_session.add(sample)
    db_session.commit()
    sample_id = sample.id

    db_session.delete(profile)
    db_session.commit()

    assert db_session.get(VoiceSample, sample_id) is None


def test_deleting_user_cascades_to_profiles(db_session) -> None:
    user = User()
    db_session.add(user)
    db_session.commit()

    profile = VoiceProfile(user_id=user.id, name="Person A", consent_confirmed=True)
    db_session.add(profile)
    db_session.commit()
    profile_id = profile.id

    db_session.delete(user)
    db_session.commit()

    assert db_session.get(VoiceProfile, profile_id) is None
