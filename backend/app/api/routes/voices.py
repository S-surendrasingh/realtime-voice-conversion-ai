import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.user import User
from app.models.voice_profile import VoiceProfile
from app.repositories import voice_sample_repository
from app.schemas.voice import (
    CompleteVoiceProfileResponse,
    ConversionResponse,
    CreateVoiceProfileRequest,
    UpdateVoiceProfileRequest,
    VoiceProfileResponse,
    build_voice_profile_response,
)
from app.services import conversion, voice_profiles
from app.services.storage import StorageService, get_storage_service

router = APIRouter(prefix="/voices", tags=["voices"])


def _get_owned_profile_or_404(db: Session, profile_id: uuid.UUID, user: User) -> VoiceProfile:
    profile = voice_profiles.get_profile(db, profile_id=profile_id, user_id=user.id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Voice profile not found.")
    return profile


def _to_response(db: Session, profile: VoiceProfile) -> VoiceProfileResponse:
    samples = voice_sample_repository.list_for_profile(db, profile.id)
    return build_voice_profile_response(profile, samples)


@router.post("", response_model=VoiceProfileResponse, status_code=status.HTTP_201_CREATED)
def create_voice_profile(
    payload: CreateVoiceProfileRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VoiceProfileResponse:
    profile = voice_profiles.create_profile(
        db,
        user_id=user.id,
        name=payload.name,
        description=payload.description,
        consent_confirmed=payload.consent_confirmed,
    )
    return _to_response(db, profile)


@router.get("", response_model=list[VoiceProfileResponse])
def list_voice_profiles(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[VoiceProfileResponse]:
    profiles = voice_profiles.list_profiles(db, user_id=user.id)
    return [_to_response(db, profile) for profile in profiles]


@router.get("/{voice_profile_id}", response_model=VoiceProfileResponse)
def get_voice_profile(
    voice_profile_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VoiceProfileResponse:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    return _to_response(db, profile)


@router.patch("/{voice_profile_id}", response_model=VoiceProfileResponse)
def update_voice_profile(
    voice_profile_id: uuid.UUID,
    payload: UpdateVoiceProfileRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VoiceProfileResponse:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    profile = voice_profiles.update_profile(
        db, profile=profile, name=payload.name, description=payload.description
    )
    return _to_response(db, profile)


@router.delete("/{voice_profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_voice_profile(
    voice_profile_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    storage: StorageService = Depends(get_storage_service),
    settings: Settings = Depends(get_settings),
) -> None:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    voice_profiles.delete_profile(db, profile=profile, storage=storage, settings=settings)


@router.post("/{voice_profile_id}/complete", response_model=CompleteVoiceProfileResponse)
def complete_voice_profile(
    voice_profile_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> CompleteVoiceProfileResponse:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    profile = voice_profiles.complete_enrollment(db, profile=profile, settings=settings)
    valid_count = voice_sample_repository.count_valid_for_profile(db, profile.id)
    return CompleteVoiceProfileResponse(
        id=profile.id,
        status=profile.status,
        valid_sample_count=valid_count,
        message="Voice profile is ready for AI processing.",
    )


@router.post("/{voice_profile_id}/convert", response_model=ConversionResponse)
async def convert_voice(
    voice_profile_id: uuid.UUID,
    source_audio: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    storage: StorageService = Depends(get_storage_service),
    settings: Settings = Depends(get_settings),
) -> ConversionResponse:
    """Person B test-conversion diagnostic (Phase 3) — converts source_audio
    toward this profile's AI-generated target voice. Requires
    READY_FOR_AI_PROCESSING; see services/conversion.py for the full flow."""
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    content = await source_audio.read()
    outcome = conversion.convert_person_b_audio(
        db,
        profile=profile,
        source_content=content,
        source_filename=source_audio.filename or "source",
        storage=storage,
        settings=settings,
    )
    return ConversionResponse(
        conversion_id=outcome.conversion_id,
        voice_profile_id=outcome.voice_profile_id,
        status=outcome.status,
        source_duration_seconds=outcome.source_duration_seconds,
        processing_time_seconds=outcome.processing_time_seconds,
        rtf=outcome.rtf,
        model=outcome.model,
        device=outcome.device,
        output_url=f"/api/v1/voices/{voice_profile_id}/conversions/{outcome.conversion_id}/audio",
    )


@router.get("/{voice_profile_id}/conversions/{conversion_id}/audio")
def get_conversion_audio(
    voice_profile_id: uuid.UUID,
    conversion_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    storage: StorageService = Depends(get_storage_service),
) -> Response:
    profile = _get_owned_profile_or_404(db, voice_profile_id, user)
    audio_bytes = conversion.get_conversion_audio(
        profile=profile, conversion_id=conversion_id, storage=storage
    )
    return Response(content=audio_bytes, media_type="audio/wav")
