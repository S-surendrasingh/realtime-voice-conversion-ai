"""Person B test-conversion orchestration (Phase 3). Bridges the enrollment
domain (voice profiles, valid samples, StorageService) to the isolated
ai-worker subprocess (app/services/ai_worker_client.py) — this is the one
place that knows about both.

No `conversions` database table: a conversion is treated as an ephemeral
diagnostic result. Its audio is retrievable at a deterministic storage key
(`voice-profiles/{id}/derived/conversions/{conversion_id}.wav`) scoped under
the owning profile, so ownership/existence checks reuse the exact same
`_get_owned_profile_or_404` convention every other route already uses —
no new table, no new auth path. See docs/phase3-ai-conversion.md
"Do we need a conversions table?" for the full reasoning.
"""

import hashlib
import json
import logging
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.voice_profile import VoiceProfile, VoiceProfileStatus
from app.models.voice_sample import VoiceSampleStatus
from app.repositories import voice_sample_repository
from app.services import ai_worker_client
from app.services.ai_worker_client import AIWorkerInvocationError
from app.services.audio_validation import AudioValidationService
from app.services.errors import DomainError
from app.services.storage import StorageError, StorageService

logger = logging.getLogger(__name__)


class ProfileNotReadyError(DomainError):
    def __init__(self) -> None:
        super().__init__("Voice profile is not READY_FOR_AI_PROCESSING yet.")


class NoValidReferenceSamplesError(DomainError):
    def __init__(self) -> None:
        super().__init__("Voice profile has no valid reference samples to convert against.")


class SourceAudioInvalidError(DomainError):
    pass


class AIConversionError(DomainError):
    status_code = 502  # not the caller's fault — the AI worker/model failed


class ConversionAudioNotFoundError(DomainError):
    status_code = 404


@dataclass(frozen=True)
class ConversionOutcome:
    conversion_id: uuid.UUID
    voice_profile_id: uuid.UUID
    status: str
    source_duration_seconds: float
    processing_time_seconds: float
    rtf: float
    model: str | None
    device: str
    engine: str


_DERIVED_PREFIX = "derived"
_last_conversion_ok: bool | None = None  # see ai_health_snapshot()


def _prepared_voice_key(profile_id: uuid.UUID, engine: str) -> str:
    return f"voice-profiles/{profile_id}/{_DERIVED_PREFIX}/{engine}/target.pt"


def _prepared_voice_metadata_key(profile_id: uuid.UUID, engine: str) -> str:
    return f"voice-profiles/{profile_id}/{_DERIVED_PREFIX}/{engine}/metadata.json"


def _conversion_audio_key(profile_id: uuid.UUID, conversion_id: uuid.UUID) -> str:
    return f"voice-profiles/{profile_id}/{_DERIVED_PREFIX}/conversions/{conversion_id}.wav"


def derived_cache_keys(profile_id: uuid.UUID, engine: str) -> list[str]:
    """The deterministically-named derived artifacts for one (profile,
    engine) pair — used by voice_profiles.delete_profile() to clean up the
    prepared-voice cache. Individual conversion outputs are NOT enumerated
    here (their ids are random, not derivable from profile_id alone) — see
    docs/phase3-ai-conversion.md "Known Limitations"."""
    return [
        _prepared_voice_key(profile_id, engine),
        _prepared_voice_metadata_key(profile_id, engine),
    ]


def _compute_cache_key(profile_id: uuid.UUID, engine: str, sample_ids: list[uuid.UUID]) -> str:
    """A sample row is immutable once created (re-uploading replaces it with
    a new id, never edits in place — see services/voice_samples.py), so the
    *set* of valid sample ids is a correct, cheap proxy for "have the
    reference recordings changed" — no need to re-read audio bytes just to
    compute this."""
    payload = "|".join([str(profile_id), engine, *sorted(str(i) for i in sample_ids)])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def convert_person_b_audio(
    db: Session,
    *,
    profile: VoiceProfile,
    source_content: bytes,
    source_filename: str,
    storage: StorageService,
    settings: Settings,
) -> ConversionOutcome:
    if profile.status is not VoiceProfileStatus.READY_FOR_AI_PROCESSING:
        raise ProfileNotReadyError

    valid_samples = [
        s
        for s in voice_sample_repository.list_for_profile(db, profile.id)
        if s.status is VoiceSampleStatus.VALID
    ]
    if not valid_samples:
        raise NoValidReferenceSamplesError

    validator = AudioValidationService(settings)
    result = validator.validate(source_content, filename=source_filename)
    if not result.valid:
        raise SourceAudioInvalidError("; ".join(result.errors) or "Source audio failed validation.")

    global _last_conversion_ok
    with tempfile.TemporaryDirectory(prefix="voiceshift-conversion-") as tmp:
        tmp_path = Path(tmp)
        source_path = tmp_path / f"source.{result.storage_extension}"
        source_path.write_bytes(source_content)

        artifact_path = tmp_path / "target.pt"
        cache_key = _compute_cache_key(
            profile.id, settings.ai_engine, [s.id for s in valid_samples]
        )
        if not _load_cached_artifact(
            storage, profile.id, settings.ai_engine, cache_key, artifact_path
        ):
            _prepare_and_cache(
                db, profile, valid_samples, storage, settings, artifact_path, cache_key, tmp_path
            )

        output_path = tmp_path / "converted.wav"
        try:
            result_dict = ai_worker_client.convert(
                settings,
                source_path=source_path,
                prepared_voice_path=artifact_path,
                output_path=output_path,
            )
        except AIWorkerInvocationError as exc:
            _last_conversion_ok = False
            raise AIConversionError(str(exc)) from exc

        if result_dict.get("status") != "completed":
            _last_conversion_ok = False
            error = result_dict.get("error") or {}
            logger.error("AI worker reported conversion failure: %s", error)
            raise AIConversionError(error.get("message", "AI conversion failed."))

        if not output_path.exists():
            _last_conversion_ok = False
            raise AIConversionError("AI worker reported success but produced no output file.")

        conversion_id = uuid.uuid4()
        storage.save(_conversion_audio_key(profile.id, conversion_id), output_path.read_bytes())

    _last_conversion_ok = True
    return ConversionOutcome(
        conversion_id=conversion_id,
        voice_profile_id=profile.id,
        status="completed",
        source_duration_seconds=result_dict["source_duration_seconds"],
        processing_time_seconds=result_dict["processing_time_seconds"],
        rtf=result_dict["rtf"],
        model=result_dict.get("model_version"),
        device=result_dict.get("device", "cpu"),
        engine=result_dict.get("engine", settings.ai_engine),
    )


def _load_cached_artifact(
    storage: StorageService, profile_id: uuid.UUID, engine: str, cache_key: str, artifact_path: Path
) -> bool:
    metadata_key = _prepared_voice_metadata_key(profile_id, engine)
    if not storage.exists(metadata_key):
        return False
    try:
        metadata = json.loads(storage.read(metadata_key))
    except (StorageError, json.JSONDecodeError):
        return False
    if metadata.get("cache_key") != cache_key:
        return False  # reference samples changed since this was cached
    try:
        artifact_path.write_bytes(storage.read(_prepared_voice_key(profile_id, engine)))
    except StorageError:
        return False
    return True


def _prepare_and_cache(
    db: Session,
    profile: VoiceProfile,
    valid_samples: list,
    storage: StorageService,
    settings: Settings,
    artifact_path: Path,
    cache_key: str,
    tmp_path: Path,
) -> None:
    reference_paths = []
    for i, sample in enumerate(valid_samples):
        try:
            content = storage.read(sample.storage_key)
        except StorageError as exc:
            raise AIConversionError(f"Could not read reference sample {sample.id}: {exc}") from exc
        ref_path = tmp_path / f"reference_{i}.wav"
        ref_path.write_bytes(content)
        reference_paths.append(ref_path)

    try:
        prepare_result = ai_worker_client.prepare_target_voice(
            settings, reference_files=reference_paths, artifact_path=artifact_path
        )
    except AIWorkerInvocationError as exc:
        raise AIConversionError(str(exc)) from exc

    if prepare_result.get("status") != "completed" or not artifact_path.exists():
        error = prepare_result.get("error") or {}
        logger.error("AI worker reported preparation failure: %s", error)
        raise AIConversionError(error.get("message", "Failed to prepare target voice."))

    storage.save(_prepared_voice_key(profile.id, settings.ai_engine), artifact_path.read_bytes())
    storage.save(
        _prepared_voice_metadata_key(profile.id, settings.ai_engine),
        json.dumps(
            {
                "cache_key": cache_key,
                "engine": settings.ai_engine,
                "prepared_voice_id": prepare_result.get("prepared_voice_id"),
                "prepared_at": datetime.now(UTC).isoformat(),
            }
        ).encode("utf-8"),
    )


def get_conversion_audio(
    *, profile: VoiceProfile, conversion_id: uuid.UUID, storage: StorageService
) -> bytes:
    try:
        return storage.read(_conversion_audio_key(profile.id, conversion_id))
    except StorageError as exc:
        raise ConversionAudioNotFoundError("Converted audio not found.") from exc


def ai_health_snapshot(settings: Settings) -> dict:
    configured = (
        Path(settings.ai_worker_dir).is_dir() and Path(settings.ai_worker_python_path).exists()
    )
    return {
        "configured": configured,
        "device": "cpu",
        "model": settings.ai_engine,
        "loaded": _last_conversion_ok,
    }
