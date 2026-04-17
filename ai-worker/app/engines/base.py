"""The model-independent voice-conversion contract. Nothing outside this
package (the CLI, the conversion service, and — one process boundary away —
FastAPI) is allowed to import a model-specific type; everything crosses this
boundary as plain paths, numpy arrays, and the dataclasses defined here.

Process-boundary note: the backend talks to this worker as a subprocess per
request (see ai-worker/README.md "Why not a resident service yet"), so
`prepare_target_voice` cannot just return an opaque id and keep the prepared
representation in memory — a *new* process runs `convert_file`. Instead the
prepared representation is serialized to `artifact_path` (a file whose
format is 100% engine-private) and every later call re-loads it from there.
The `str` id returned is only ever used for logging/cache-key purposes, not
for lookup — the artifact_path is what actually carries state across the
process boundary. `create_stream` is the one exception: it is an in-process
API only (see StreamSession) and is never used across the subprocess
boundary in Phase 3.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import numpy as np


class EngineState(str, Enum):
    NOT_LOADED = "NOT_LOADED"
    LOADING = "LOADING"
    WARMING_UP = "WARMING_UP"
    READY = "READY"
    CONVERTING = "CONVERTING"
    STREAMING = "STREAMING"
    ERROR = "ERROR"
    SHUTTING_DOWN = "SHUTTING_DOWN"


@dataclass
class EngineHealth:
    state: EngineState
    device: str
    engine_name: str
    model_name: str | None = None
    model_version: str | None = None
    configured: bool = True
    loaded: bool = False
    detail: str | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state.value,
            "device": self.device,
            "engine": self.engine_name,
            "model": self.model_name,
            "model_version": self.model_version,
            "configured": self.configured,
            "loaded": self.loaded,
            "detail": self.detail,
        }


@dataclass
class ConversionMetrics:
    """What every convert_file() call must report — no field here may be
    fabricated; an engine that can't measure one (e.g. peak RAM) omits it
    (leaves the default) rather than inventing a number."""

    processing_time_seconds: float
    source_duration_seconds: float
    output_duration_seconds: float
    output_sample_rate: int
    prepared_voice_id: str = ""
    diffusion_steps: int | None = None
    peak_rss_mb: float | None = None

    @property
    def rtf(self) -> float:
        if self.source_duration_seconds <= 0:
            return float("inf")
        return self.processing_time_seconds / self.source_duration_seconds


class StreamSession(ABC):
    """In-process, framework-independent streaming lifecycle. Not reachable
    from the FastAPI backend in Phase 3 (see NOT_IMPLEMENTED note in
    ai-worker/README.md) — this exists so Phase 4 (Electron + a resident
    local engine process) can drive real-time conversion without any change
    to engine internals. Any chunk-to-chunk state (diffusion context,
    crossfade tail, etc.) lives inside the concrete session, never leaks to
    a caller."""

    @abstractmethod
    def process(self, audio_chunk: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
        """Returns (converted_samples, output_sample_rate). The output rate
        is reported explicitly rather than assumed to match the input rate —
        SeedVCVoiceEngine's output is always at its own internal rate (22050)
        regardless of what sample rate audio was fed in."""

    @abstractmethod
    def close(self) -> None: ...


class VoiceConversionEngine(ABC):
    @abstractmethod
    def load(self) -> None:
        """Load model weights into memory. Idempotent — calling load() on an
        already-READY engine is a no-op. Raises AIEngineError(MODEL_NOT_FOUND
        / MODEL_LOAD_FAILED / MODEL_DOWNLOAD_FAILED) on failure."""

    @abstractmethod
    def warmup(self) -> None:
        """Run one throwaway inference so the first real request doesn't pay
        first-call JIT/allocation cost. No-op for engines with nothing to
        warm up (e.g. PassthroughVoiceEngine)."""

    @abstractmethod
    def prepare_target_voice(
        self,
        reference_files: list[Path],
        artifact_path: Path,
        max_reference_seconds: float | None = None,
    ) -> str:
        """Build a target-voice representation from Person A's reference
        clips and serialize it to artifact_path. Returns a short id (for
        logs/cache-keys — NOT a lookup key; artifact_path is what's reloaded
        later). Raises AIEngineError(TARGET_VOICE_PREPARATION_FAILED).

        `max_reference_seconds` caps how much reference audio is actually
        used, independent of an engine's own offline default — Phase 3.1
        profiling found per-chunk diffusion cost scales with reference
        length, not chunk length (see docs/phase3.1-resident-engine.md
        "Root Cause"), so the resident streaming engine deliberately
        prepares targets from a much shorter reference than the offline
        path uses. None means "use the engine's own default"."""

    @abstractmethod
    def convert_file(
        self,
        source_audio: Path,
        prepared_voice_path: Path,
        output_path: Path,
    ) -> ConversionMetrics:
        """Convert source_audio toward the voice serialized at
        prepared_voice_path, writing a WAV to output_path. Raises
        AIEngineError(CONVERSION_FAILED / INVALID_MODEL_OUTPUT)."""

    @abstractmethod
    def process_chunk(
        self,
        audio_chunk: np.ndarray,
        sample_rate: int,
        prepared_voice_path: Path,
    ) -> np.ndarray:
        """Convert one chunk without the file-level context a full
        convert_file() call has. Used by the offline chunked-conversion
        harness (audio/chunking.py) to benchmark real-time feasibility —
        NOT a substitute for create_stream()'s stateful session, which is
        the intended Phase-4 entry point for actual continuous streaming."""

    @abstractmethod
    def create_stream(self, prepared_voice_path: Path) -> StreamSession:
        """Open an in-process streaming session. See StreamSession."""

    @abstractmethod
    def health_check(self) -> EngineHealth: ...

    @abstractmethod
    def unload(self) -> None:
        """Release model memory. Idempotent."""
