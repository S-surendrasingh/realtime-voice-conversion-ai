import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.voice_profile import VoiceProfile, VoiceProfileStatus
from app.models.voice_sample import VoiceSample, VoiceSampleStatus


class CreateVoiceProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    consent_confirmed: bool

    @field_validator("consent_confirmed")
    @classmethod
    def must_confirm_consent(cls, value: bool) -> bool:
        if not value:
            raise ValueError(
                "You must confirm you have permission to create and use this voice profile."
            )
        return value


class UpdateVoiceProfileRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class VoiceProfileResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    status: VoiceProfileStatus
    consent_confirmed: bool
    consent_confirmed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    sample_count: int
    valid_sample_count: int
    total_duration_seconds: float


class VoiceSampleResponse(BaseModel):
    id: uuid.UUID
    voice_profile_id: uuid.UUID
    original_filename: str
    mime_type: str
    file_size: int
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    status: VoiceSampleStatus
    validation_error: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CompleteVoiceProfileResponse(BaseModel):
    id: uuid.UUID
    status: VoiceProfileStatus
    valid_sample_count: int
    message: str


class ConversionResponse(BaseModel):
    conversion_id: uuid.UUID
    voice_profile_id: uuid.UUID
    status: str
    source_duration_seconds: float
    processing_time_seconds: float
    rtf: float
    model: str | None
    device: str
    output_url: str


class AudioValidationResultSchema(BaseModel):
    valid: bool
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    errors: list[str]


def build_voice_profile_response(
    profile: VoiceProfile, samples: list[VoiceSample]
) -> VoiceProfileResponse:
    valid_samples = [s for s in samples if s.status is VoiceSampleStatus.VALID]
    return VoiceProfileResponse(
        id=profile.id,
        name=profile.name,
        description=profile.description,
        status=profile.status,
        consent_confirmed=profile.consent_confirmed,
        consent_confirmed_at=profile.consent_confirmed_at,
        created_at=profile.created_at,
        updated_at=profile.updated_at,
        sample_count=len(samples),
        valid_sample_count=len(valid_samples),
        total_duration_seconds=sum(s.duration_seconds or 0.0 for s in valid_samples),
    )
