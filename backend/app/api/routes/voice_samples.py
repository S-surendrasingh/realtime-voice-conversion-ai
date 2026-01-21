import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_audio_validation_service, get_current_user
from app.db.session import get_db
from app.models.user import User
from app.models.voice_profile import VoiceProfile
from app.schemas.voice import VoiceSampleResponse
from app.services import voice_samples
from app.services.audio_validation import AudioValidationService
from app.services.storage import StorageError, StorageService, get_storage_service
from app.services.voice_profiles import get_profile

router = APIRouter(prefix="/voices/{voice_profile_id}/samples", tags=["voice-samples"])


def _get_owned_profile_or_404(db: Session, voice_profile_id: uuid.UUID, user: User) -> VoiceProfile:
    profile = get_profile(db, profile_id=voice_profile_id, user_id=user.id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice profile not found.")
    return profile


@router.post("", response_model=VoiceSampleResponse, status_code=status.HTTP_201_CREATED)
async def upload_voice_sample(
    voice_profile_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    validator: AudioValidationService = Depends(get_audio_validation_service),
    storage: StorageService = Depends(get_storage_service),
) -> VoiceSampleResponse:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    content = await file.read()
    sample = voice_samples.upload_sample(
        db,
        profile=profile,
        content=content,
        original_filename=file.filename or "sample",
        declared_mime_type=file.content_type or "application/octet-stream",
        validator=validator,
        storage=storage,
    )
    return VoiceSampleResponse.model_validate(sample)


@router.get("", response_model=list[VoiceSampleResponse])
def list_voice_samples(
    voice_profile_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[VoiceSampleResponse]:
    _get_owned_profile_or_404(db, voice_profile_id, user)
    samples = voice_samples.list_samples(db, voice_profile_id=voice_profile_id)
    return [VoiceSampleResponse.model_validate(sample) for sample in samples]


@router.get("/{sample_id}", response_model=VoiceSampleResponse)
def get_voice_sample(
    voice_profile_id: uuid.UUID,
    sample_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VoiceSampleResponse:
    _get_owned_profile_or_404(db, voice_profile_id, user)
    sample = voice_samples.get_sample(db, sample_id=sample_id, voice_profile_id=voice_profile_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice sample not found.")
    return VoiceSampleResponse.model_validate(sample)


@router.get("/{sample_id}/audio")
def get_voice_sample_audio(
    voice_profile_id: uuid.UUID,
    sample_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    storage: StorageService = Depends(get_storage_service),
) -> Response:
    """Raw reference-sample audio bytes, for callers that need a local copy
    of the enrolled reference material (e.g. the Phase 4 desktop app
    materializing temp files for the resident engine's engine.load_voice —
    see docs/phase4-desktop.md). Mirrors the existing
    GET .../conversions/{conversion_id}/audio pattern."""
    _get_owned_profile_or_404(db, voice_profile_id, user)
    sample = voice_samples.get_sample(db, sample_id=sample_id, voice_profile_id=voice_profile_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice sample not found.")
    try:
        content = storage.read(sample.storage_key)
    except StorageError as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Voice sample audio not found in storage."
        ) from exc
    return Response(content=content, media_type=sample.mime_type)


@router.delete("/{sample_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_voice_sample(
    voice_profile_id: uuid.UUID,
    sample_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    storage: StorageService = Depends(get_storage_service),
) -> None:
    _get_owned_profile_or_404(db, voice_profile_id, user)
    sample = voice_samples.get_sample(db, sample_id=sample_id, voice_profile_id=voice_profile_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice sample not found.")
    voice_samples.delete_sample(db, sample=sample, storage=storage)
