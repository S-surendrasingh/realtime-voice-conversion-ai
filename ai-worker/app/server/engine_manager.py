"""Owns the single resident VoiceConversionEngine instance for the server
process, plus the in-memory prepared-target-voice cache that makes
`engine.load_voice` cheap on repeat calls for the same target. See
docs/phase3.1-resident-engine.md "Target Voice Cache".
"""

import logging
from pathlib import Path

from app.core.config import Settings
from app.engines.base import EngineHealth, EngineState, VoiceConversionEngine
from app.voices.cache import compute_cache_key, hash_file

logger = logging.getLogger("app.server.engine_manager")


class EngineManager:
    def __init__(self, engine: VoiceConversionEngine, artifact_dir: Path, settings: Settings):
        self._engine = engine
        self._artifact_dir = artifact_dir
        self._settings = settings
        self._target_cache: dict[str, tuple[str, Path]] = {}
        self._profile_to_cache_key: dict[str, str] = {}
        self.load_call_count = 0  # test hook: proves load() only runs once

    @property
    def engine(self) -> VoiceConversionEngine:
        return self._engine

    def ensure_loaded(self) -> None:
        """Idempotent: load()/warmup() run at most once — calling this
        again while already READY/STREAMING is a guaranteed no-op. See
        tests/unit/test_engine_manager.py for the counter-based proof."""
        state = self._engine.health_check().state
        if state in (EngineState.NOT_LOADED, EngineState.ERROR):
            self.load_call_count += 1
            self._engine.load()
            self._engine.warmup()

    def health(self) -> EngineHealth:
        return self._engine.health_check()

    def load_voice(self, voice_profile_id: str, reference_paths: list[Path]) -> tuple[str, Path]:
        """Returns (prepared_voice_id, artifact_path). Cache key incorporates
        the voice profile id, engine name, model version, and the sorted set
        of reference file hashes — changing any reference invalidates it."""
        self.ensure_loaded()
        ordered_refs = sorted(reference_paths)
        reference_hashes = [hash_file(p) for p in ordered_refs]
        health = self._engine.health_check()
        cache_key = compute_cache_key(
            voice_profile_id, health.engine_name, health.model_version or "", reference_hashes
        )

        cached = self._target_cache.get(cache_key)
        if cached is not None:
            logger.info("Target voice cache HIT for profile %s", voice_profile_id)
            self._profile_to_cache_key[voice_profile_id] = cache_key
            return cached

        logger.info("Target voice cache MISS for profile %s — preparing", voice_profile_id)
        self._artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = self._artifact_dir / f"{cache_key}.pt"
        prepared_voice_id = self._engine.prepare_target_voice(
            ordered_refs, artifact_path, max_reference_seconds=self._settings.stream_reference_seconds
        )
        self._target_cache[cache_key] = (prepared_voice_id, artifact_path)
        self._profile_to_cache_key[voice_profile_id] = cache_key
        return prepared_voice_id, artifact_path

    def unload_voice(self, voice_profile_id: str) -> bool:
        cache_key = self._profile_to_cache_key.pop(voice_profile_id, None)
        if cache_key is None:
            return False
        cached = self._target_cache.pop(cache_key, None)
        if cached is not None:
            _prepared_voice_id, artifact_path = cached
            artifact_path.unlink(missing_ok=True)
        return True

    def cached_target_count(self) -> int:
        return len(self._target_cache)

    def shutdown(self) -> None:
        for _prepared_voice_id, artifact_path in self._target_cache.values():
            artifact_path.unlink(missing_ok=True)
        self._target_cache.clear()
        self._profile_to_cache_key.clear()
        self._engine.unload()
