"""Deterministic, zero-dependency engine used for architecture validation,
CLI/API integration tests, and as an explicit fallback diagnostic when the
real neural engine can't load. It performs no voice conversion — it decodes
and re-encodes the source audio unchanged (mono, resampled to a fixed rate)
so every downstream consumer (backend response shape, frontend playback,
benchmark harness) can be exercised without ever downloading a model.
"""

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from app.core.config import Settings
from app.core.errors import AIEngineError, AIErrorCode
from app.engines.base import (
    ConversionMetrics,
    EngineHealth,
    EngineState,
    StreamSession,
    VoiceConversionEngine,
)

_OUTPUT_SAMPLE_RATE = 22050


class _PassthroughStreamSession(StreamSession):
    def process(self, audio_chunk: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
        return audio_chunk, sample_rate

    def close(self) -> None:
        pass


class PassthroughVoiceEngine(VoiceConversionEngine):
    def __init__(self, settings: Settings):
        self._settings = settings
        self._state = EngineState.NOT_LOADED

    def load(self) -> None:
        self._state = EngineState.READY

    def warmup(self) -> None:
        pass

    def prepare_target_voice(
        self, reference_files: list[Path], artifact_path: Path, max_reference_seconds: float | None = None
    ) -> str:
        if not reference_files:
            raise AIEngineError(AIErrorCode.TARGET_VOICE_PREPARATION_FAILED, "No reference files supplied")
        hasher = hashlib.sha256()
        for ref in sorted(reference_files):
            hasher.update(ref.read_bytes())
        prepared_id = hasher.hexdigest()[:16]
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(json.dumps({"engine": "passthrough", "prepared_voice_id": prepared_id}))
        return prepared_id

    def convert_file(
        self, source_audio: Path, prepared_voice_path: Path, output_path: Path
    ) -> ConversionMetrics:
        if not prepared_voice_path.exists():
            raise AIEngineError(
                AIErrorCode.TARGET_VOICE_NOT_READY, f"No prepared voice at {prepared_voice_path}"
            )
        prepared = json.loads(prepared_voice_path.read_text())

        start = time.monotonic()
        try:
            audio, sr = sf.read(source_audio, dtype="float32", always_2d=False)
        except Exception as exc:
            raise AIEngineError(AIErrorCode.SOURCE_AUDIO_INVALID, str(exc)) from exc
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        source_duration = len(audio) / sr if sr else 0.0

        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, audio, sr, subtype="PCM_16")
        elapsed = time.monotonic() - start

        return ConversionMetrics(
            processing_time_seconds=elapsed,
            source_duration_seconds=source_duration,
            output_duration_seconds=source_duration,
            output_sample_rate=sr,
            prepared_voice_id=prepared.get("prepared_voice_id", ""),
        )

    def process_chunk(
        self, audio_chunk: np.ndarray, sample_rate: int, prepared_voice_path: Path
    ) -> np.ndarray:
        return audio_chunk

    def create_stream(self, prepared_voice_path: Path) -> StreamSession:
        return _PassthroughStreamSession()

    def health_check(self) -> EngineHealth:
        return EngineHealth(
            state=self._state,
            device="cpu",
            engine_name="passthrough",
            model_name="passthrough",
            model_version="n/a",
            configured=True,
            loaded=self._state == EngineState.READY,
        )

    def unload(self) -> None:
        self._state = EngineState.NOT_LOADED
