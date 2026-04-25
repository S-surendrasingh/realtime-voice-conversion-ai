from dataclasses import dataclass
from pathlib import Path


@dataclass
class ReferenceSample:
    path: Path
    duration_seconds: float


@dataclass
class PreparedVoiceMetadata:
    """Written alongside the engine-private artifact file so a caller (the
    backend) can tell, without re-deriving anything, whether a cached
    artifact is still valid for the profile's current reference samples."""

    voice_profile_id: str
    engine_name: str
    model_version: str
    reference_hashes: list[str]
    prepared_at: str
    prepared_voice_id: str
    cache_key: str

    def to_dict(self) -> dict:
        return {
            "voice_profile_id": self.voice_profile_id,
            "engine_name": self.engine_name,
            "model_version": self.model_version,
            "reference_hashes": self.reference_hashes,
            "prepared_at": self.prepared_at,
            "prepared_voice_id": self.prepared_voice_id,
            "cache_key": self.cache_key,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PreparedVoiceMetadata":
        return cls(**data)
