"""Deterministic fake VoiceConversionEngine for resident-engine/server tests
— no real weights, no torch. Call counters prove load-once/warmup-once
semantics; `process_delay_seconds` and `fail_next_chunk` let tests exercise
backpressure and error-recovery paths on demand.
"""

import time
from pathlib import Path

import numpy as np

from app.engines.base import EngineHealth, EngineState, StreamSession, VoiceConversionEngine


class FakeStreamSession(StreamSession):
    def __init__(self, engine: "FakeVoiceConversionEngine"):
        self._engine = engine
        self.closed = False

    def process(self, audio_chunk: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
        self._engine.process_chunk_count += 1
        if self._engine.process_delay_seconds:
            time.sleep(self._engine.process_delay_seconds)
        if self._engine.fail_next_chunk:
            self._engine.fail_next_chunk = False
            raise RuntimeError("simulated chunk processing failure")
        return audio_chunk * self._engine.gain, sample_rate

    def close(self) -> None:
        self.closed = True


class FakeVoiceConversionEngine(VoiceConversionEngine):
    def __init__(self, process_delay_seconds: float = 0.0):
        self._state = EngineState.NOT_LOADED
        self.load_count = 0
        self.warmup_count = 0
        self.unload_count = 0
        self.process_chunk_count = 0
        self.prepare_calls: list[list[Path]] = []
        self.process_delay_seconds = process_delay_seconds
        self.fail_next_chunk = False
        self.gain = 1.0  # lets a test tell two prepared voices apart by effect

    def load(self) -> None:
        self.load_count += 1
        self._state = EngineState.READY

    def warmup(self) -> None:
        self.warmup_count += 1

    def prepare_target_voice(
        self, reference_files: list[Path], artifact_path: Path, max_reference_seconds: float | None = None
    ) -> str:
        self.prepare_calls.append(list(reference_files))
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(f"fake-target:gain={self.gain}")
        return f"fake-voice-{len(self.prepare_calls)}"

    def convert_file(self, source_audio, prepared_voice_path, output_path):
        raise NotImplementedError("not exercised by resident-engine tests")

    def process_chunk(
        self, audio_chunk: np.ndarray, sample_rate: int, prepared_voice_path: Path
    ) -> np.ndarray:
        self.process_chunk_count += 1
        return audio_chunk * self.gain

    def create_stream(self, prepared_voice_path: Path, **_kwargs) -> StreamSession:
        return FakeStreamSession(self)

    def health_check(self) -> EngineHealth:
        return EngineHealth(
            state=self._state,
            device="cpu",
            engine_name="fake",
            model_name="fake-model",
            model_version="v1",
            configured=True,
            loaded=self._state == EngineState.READY,
        )

    def unload(self) -> None:
        self.unload_count += 1
        self._state = EngineState.NOT_LOADED
