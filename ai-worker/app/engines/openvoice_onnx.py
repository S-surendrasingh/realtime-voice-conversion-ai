"""CPU voice-conversion engine using OpenVoice V2's tone-color converter,
run via ONNX Runtime (CPUExecutionProvider only, never CUDA). See
docs/phase3.2-openvoice-onnx.md for the independent technical verification
behind this choice, and docs/model-selection.md for the MIT license (both
code and weights — a materially different distribution posture than
SeedVCVoiceEngine's GPL-3.0, compared there).

Architecture (verified directly from the official myshell-ai/OpenVoice
source, not assumed): the tone-color converter is a VITS-style flow-based
model. `SynthesizerTrn.voice_conversion()` is a SINGLE forward pass
(posterior encoder -> flow -> inverse-flow -> decoder) — there is no
iterative diffusion sampling loop the way Seed-VC's DiT has one. This is
the structural reason it measures faster on CPU (confirmed empirically,
not just architecturally — see the benchmark doc).

This engine drives two ONNX graphs — a real, verified community export
(`seasonstudio/openvoice_tone_clone_onnx`) whose bundled config.json exactly
matches the official converter/config.json's architecture parameters
(sampling_rate, filter_length, hop_length, gin_channels all identical):
  - tone_color_extract_model.onnx: spectrogram -> 256-dim speaker embedding
  - tone_clone_model.onnx: (spectrogram, audio_length, src_tone, dest_tone,
    tau) -> converted waveform (output index 0, confirmed by inspecting
    shapes/values directly — the other four outputs are an all-ones mask
    and three internal 192-channel latents, not audio)

Both ONNX graphs operate on plain numpy arrays — no PyTorch tensors persist
past the spectrogram computation, no CUDA anywhere.

Design note on `src_tone`: the official model is NOT `zero_g` on both ends
(verified from source — zero_g only affects the posterior encoder and
decoder conditioning, not the two flow passes), so both the source and
target speaker embeddings genuinely affect the output. Since a live
Person B's exact tone can drift chunk-to-chunk, this engine extracts
`src_tone` fresh from each conversion call's own audio rather than caching
it — verified cheap (~6-30ms for the reference encoder, see the benchmark
doc), not a hidden bottleneck.
"""

import logging
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf

from app.audio.profiling import NULL_PROFILER, Profiler
from app.core.config import Settings
from app.core.errors import AIEngineError, AIErrorCode
from app.engines.base import (
    ConversionMetrics,
    EngineHealth,
    EngineState,
    StreamSession,
    VoiceConversionEngine,
)

logger = logging.getLogger("app.engines.openvoice_onnx")

_N_FFT = 1024
_HOP_LENGTH = 256
_WIN_LENGTH = 1024
_MAX_REF_SECONDS = 25.0  # matches SeedVCVoiceEngine's offline default cap
_AUDIO_OUTPUT_INDEX = 0  # verified empirically — see module docstring


def _spectrogram(audio: np.ndarray) -> np.ndarray:
    """Reimplements openvoice/mel_processing.py::spectrogram_torch exactly
    (reflect-pad by (n_fft-hop)/2 each side, Hann window, center=False STFT,
    magnitude spectrogram) — fetched from and verified against the upstream
    source directly, not guessed. Returns shape (1, n_fft//2+1, T)."""
    import torch

    y = torch.from_numpy(np.ascontiguousarray(audio, dtype="float32")).unsqueeze(0)
    pad = (_N_FFT - _HOP_LENGTH) // 2
    y = torch.nn.functional.pad(y.unsqueeze(1), (pad, pad), mode="reflect").squeeze(1)
    window = torch.hann_window(_WIN_LENGTH)
    spec = torch.stft(
        y,
        _N_FFT,
        hop_length=_HOP_LENGTH,
        win_length=_WIN_LENGTH,
        window=window,
        center=False,
        pad_mode="reflect",
        normalized=False,
        onesided=True,
        return_complex=True,
    )
    spec = torch.sqrt(spec.real.pow(2) + spec.imag.pow(2) + 1e-6)
    return spec.numpy().astype("float32")


def _resample_if_needed(audio: np.ndarray, sample_rate: int, target_sr: int) -> np.ndarray:
    if sample_rate == target_sr:
        return audio.astype("float32")
    import librosa

    return librosa.resample(audio.astype("float32"), orig_sr=sample_rate, target_sr=target_sr)


class OpenVoiceOnnxEngine(VoiceConversionEngine):
    def __init__(self, settings: Settings):
        self._settings = settings
        self._state = EngineState.NOT_LOADED
        self._error_detail: str | None = None
        self._extract_session: ort.InferenceSession | None = None
        self._clone_session: ort.InferenceSession | None = None
        self._artifact_cache: dict[str, np.ndarray] = {}
        self.profiler: Profiler = NULL_PROFILER

    def set_profiler(self, profiler: Profiler | None) -> None:
        self.profiler = profiler or NULL_PROFILER

    # -- lifecycle ------------------------------------------------------

    def load(self) -> None:
        if self._state in (
            EngineState.READY,
            EngineState.WARMING_UP,
            EngineState.CONVERTING,
            EngineState.STREAMING,
        ):
            return
        self._state = EngineState.LOADING
        try:
            self._load_sessions()
        except AIEngineError:
            self._state = EngineState.ERROR
            raise
        except Exception as exc:
            self._state = EngineState.ERROR
            self._error_detail = str(exc)
            raise AIEngineError(
                AIErrorCode.MODEL_LOAD_FAILED, f"Failed to load openvoice_onnx: {exc}"
            ) from exc
        self._state = EngineState.READY

    def warmup(self) -> None:
        if self._state != EngineState.READY:
            self.load()
        self._state = EngineState.WARMING_UP
        try:
            silence = np.zeros(self._settings.openvoice_sample_rate // 2, dtype="float32")
            spec = _spectrogram(silence)
            self._extract_session.run(None, {"input": spec})
        except Exception as exc:  # warmup failures are non-fatal, just logged
            logger.warning("Warmup pass failed (continuing): %s", exc)
        finally:
            self._state = EngineState.READY

    def unload(self) -> None:
        self._extract_session = None
        self._clone_session = None
        self._artifact_cache.clear()
        self._state = EngineState.NOT_LOADED

    def health_check(self) -> EngineHealth:
        return EngineHealth(
            state=self._state,
            device="cpu",
            engine_name="openvoice_onnx",
            model_name=self._settings.openvoice_tone_clone_file,
            model_version=self._settings.openvoice_model_version,
            configured=True,
            loaded=self._state in (EngineState.READY, EngineState.CONVERTING, EngineState.STREAMING),
            detail=self._error_detail,
        )

    # -- model loading ----------------------------------------------------

    def _download(self, repo_id: str, filename: str) -> Path:
        from huggingface_hub import hf_hub_download

        cache_dir = self._settings.model_cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            path = hf_hub_download(repo_id=repo_id, filename=filename, cache_dir=str(cache_dir))
        except Exception as exc:
            raise AIEngineError(
                AIErrorCode.MODEL_DOWNLOAD_FAILED, f"Failed to download {repo_id}/{filename}: {exc}"
            ) from exc
        return Path(path)

    def _write_manifest(self, clone_path: Path) -> None:
        import hashlib
        import json

        sha256 = hashlib.sha256()
        with open(clone_path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                sha256.update(block)
        manifest = {
            "name": self._settings.openvoice_model_version,
            "version": self._settings.openvoice_model_version,
            "source": f"https://huggingface.co/{self._settings.openvoice_onnx_repo}"
            " (community ONNX export, architecture params verified against the"
            " official myshell-ai/OpenVoiceV2 converter/config.json)",
            "license": "MIT (code and weights) — see docs/model-selection.md",
            "checksum": f"sha256:{sha256.hexdigest()}",
            "size": clone_path.stat().st_size,
        }
        model_dir = self._settings.model_cache_dir / self._settings.openvoice_model_version
        model_dir.mkdir(parents=True, exist_ok=True)
        (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    def _load_sessions(self) -> None:
        extract_path = self._download(
            self._settings.openvoice_onnx_repo, self._settings.openvoice_tone_extract_file
        )
        clone_path = self._download(
            self._settings.openvoice_onnx_repo, self._settings.openvoice_tone_clone_file
        )
        self._write_manifest(clone_path)

        options = ort.SessionOptions()
        if self._settings.ort_intra_op_num_threads:
            options.intra_op_num_threads = self._settings.ort_intra_op_num_threads
        if self._settings.ort_inter_op_num_threads:
            options.inter_op_num_threads = self._settings.ort_inter_op_num_threads
        options.graph_optimization_level = getattr(
            ort.GraphOptimizationLevel, self._settings.ort_graph_optimization_level.value
        )

        # CPUExecutionProvider only — never request CUDA, regardless of what
        # might be installed/available.
        self._extract_session = ort.InferenceSession(
            str(extract_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._clone_session = ort.InferenceSession(
            str(clone_path), sess_options=options, providers=["CPUExecutionProvider"]
        )

    # -- tone color -------------------------------------------------------

    def _extract_tone(self, audio: np.ndarray) -> np.ndarray:
        spec = _spectrogram(audio)
        (tone,) = self._extract_session.run(None, {"input": spec})
        return tone.reshape(1, 256, 1).astype("float32")

    def prepare_target_voice(
        self, reference_files: list[Path], artifact_path: Path, max_reference_seconds: float | None = None
    ) -> str:
        if self._state not in (
            EngineState.READY,
            EngineState.CONVERTING,
            EngineState.WARMING_UP,
            EngineState.STREAMING,
        ):
            self.load()
        cap_seconds = max_reference_seconds if max_reference_seconds is not None else _MAX_REF_SECONDS
        sr = self._settings.openvoice_sample_rate
        try:
            with self.profiler.stage("decode_references"):
                waves = []
                for path in reference_files:
                    audio, file_sr = sf.read(str(path), dtype="float32", always_2d=False)
                    if audio.ndim > 1:
                        audio = audio.mean(axis=1)
                    waves.append(_resample_if_needed(audio, file_sr, sr))
                ref_audio = np.concatenate(waves)[: int(sr * cap_seconds)]
            with self.profiler.stage("tone_color_extraction"):
                dest_tone = self._extract_tone(ref_audio)
        except Exception as exc:
            raise AIEngineError(
                AIErrorCode.TARGET_VOICE_PREPARATION_FAILED, f"Failed to prepare target voice: {exc}"
            ) from exc

        prepared_voice_id = f"openvoice-{abs(hash(ref_audio.tobytes())) % (10**12):012d}"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(artifact_path, dest_tone)
        # np.save appends .npy if the given path doesn't already end with it —
        # normalize so _load_artifact can find it back at the exact path we
        # were given (matching every other engine's artifact_path contract).
        saved_path = (
            artifact_path.with_suffix(artifact_path.suffix + ".npy")
            if artifact_path.suffix != ".npy"
            else artifact_path
        )
        if saved_path != artifact_path and saved_path.exists():
            saved_path.replace(artifact_path)
        return prepared_voice_id

    def _load_artifact(self, artifact_path: Path) -> np.ndarray:
        key = str(artifact_path)
        cached = self._artifact_cache.get(key)
        if cached is not None:
            return cached
        if not artifact_path.exists():
            raise AIEngineError(AIErrorCode.TARGET_VOICE_NOT_READY, f"No prepared voice at {artifact_path}")
        data = np.load(artifact_path)
        self._artifact_cache[key] = data
        return data

    # -- conversion -------------------------------------------------------

    def _run_clone(self, audio: np.ndarray, dest_tone: np.ndarray) -> np.ndarray:
        with self.profiler.stage("spectrogram"):
            spec = _spectrogram(audio)
        with self.profiler.stage("src_tone_extraction"):
            src_tone = self._extract_tone(audio)
        with self.profiler.stage("tone_clone_inference"):
            outputs = self._clone_session.run(
                None,
                {
                    "audio": spec,
                    "audio_length": np.array([spec.shape[-1]], dtype="int64"),
                    "src_tone": src_tone,
                    "dest_tone": dest_tone,
                    "tau": np.array([self._settings.openvoice_tau], dtype="float32"),
                },
            )
        return outputs[_AUDIO_OUTPUT_INDEX].reshape(-1).astype("float32")

    def convert_file(
        self, source_audio: Path, prepared_voice_path: Path, output_path: Path
    ) -> ConversionMetrics:
        if self._state not in (EngineState.READY, EngineState.WARMING_UP):
            self.load()
        self._state = EngineState.CONVERTING
        sr = self._settings.openvoice_sample_rate
        try:
            with self.profiler.stage("load_artifact"):
                dest_tone = self._load_artifact(prepared_voice_path)
            with self.profiler.stage("decode_source"):
                audio, file_sr = sf.read(str(source_audio), dtype="float32", always_2d=False)
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
                audio = _resample_if_needed(audio, file_sr, sr)
                source_duration = len(audio) / sr

            start = time.monotonic()
            output = self._run_clone(audio, dest_tone)
            elapsed = time.monotonic() - start

            from app.audio.postprocessing import write_wav

            write_wav(output_path, output, sr)
            return ConversionMetrics(
                processing_time_seconds=elapsed,
                source_duration_seconds=source_duration,
                output_duration_seconds=len(output) / sr,
                output_sample_rate=sr,
                prepared_voice_id="",
            )
        except AIEngineError:
            raise
        except Exception as exc:
            raise AIEngineError(AIErrorCode.CONVERSION_FAILED, f"Conversion failed: {exc}") from exc
        finally:
            self._state = EngineState.READY

    def process_chunk(
        self, audio_chunk: np.ndarray, sample_rate: int, prepared_voice_path: Path
    ) -> np.ndarray:
        if self._state not in (EngineState.READY, EngineState.WARMING_UP, EngineState.STREAMING):
            self.load()
        sr = self._settings.openvoice_sample_rate
        dest_tone = self._load_artifact(prepared_voice_path)
        audio = _resample_if_needed(audio_chunk, sample_rate, sr)
        return self._run_clone(audio, dest_tone)

    def create_stream(self, prepared_voice_path: Path) -> StreamSession:
        return _OpenVoiceStreamSession(self, prepared_voice_path, overlap_ms=self._settings.stream_overlap_ms)


class _OpenVoiceStreamSession(StreamSession):
    """Simpler than Seed-VC's — no reference-length-dependent cost, so no
    context-window trick is needed for speed (see docs/phase3.2-openvoice-onnx.md
    "Streaming Implementation"). Each chunk is converted independently
    (src_tone extracted fresh each call — verified cheap) and stitched with
    the same equal-power crossfade used elsewhere in this project, purely
    for boundary continuity."""

    def __init__(self, engine: OpenVoiceOnnxEngine, prepared_voice_path: Path, overlap_ms: int = 40):
        self._engine = engine
        self._prepared_voice_path = prepared_voice_path
        self._sr = engine._settings.openvoice_sample_rate
        self._overlap_samples = int(self._sr * overlap_ms / 1000)
        self._previous_tail: np.ndarray | None = None

    def process(self, audio_chunk: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
        from app.audio.continuity import equal_power_crossfade

        output = self._engine.process_chunk(audio_chunk, sample_rate, self._prepared_voice_path)
        if self._previous_tail is not None and len(output) > 0:
            output = equal_power_crossfade(self._previous_tail, output, self._overlap_samples)
        if len(output) >= self._overlap_samples:
            self._previous_tail = output[-self._overlap_samples :]
        return output, self._sr

    def close(self) -> None:
        self._previous_tail = None
