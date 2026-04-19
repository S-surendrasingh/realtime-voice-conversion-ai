"""Real CPU voice-conversion engine, adapted from Plachtaa/seed-vc
(vendor/seed-vc, GPL-3.0 — see docs/model-selection.md) using the
"seed-uvit-tat-xlsr-tiny" checkpoint (DiT_uvit_tat_xlsr_ema.pth / 25M
params + a frozen facebook/wav2vec2-xls-r-300m feature extractor).

This is NOT a call into the upstream repo's inference.py — that script is
GPU-first (module-level `cuda if available` device selection) and its xlsr
code path unconditionally calls `.half()` on the wav2vec2 feature extractor,
which is unsafe/unsupported on most CPU builds of PyTorch. Instead this
file re-implements the same load -> prepare -> convert sequence (verified
against inference.py, fetched fresh from the upstream repo — see the
research notes in docs/model-selection.md) directly in float32, with the
device hardcoded to CPU rather than probed, per the project's "no silent
cuda-if-available" rule.

Vendored building blocks (modules/*, from vendor/seed-vc) are imported for
their pure model/DSP code (the DiT architecture, CAMPPlus speaker encoder,
HiFT vocoder, mel-spectrogram function) — none of that code branches on
device the way inference.py's driver logic does, so it is safe to reuse.
"""

import json
import logging
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torchaudio
import yaml
from huggingface_hub import hf_hub_download

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

logger = logging.getLogger("app.engines.seed_vc")

_VENDOR_ROOT = Path(__file__).resolve().parents[2] / "vendor" / "seed-vc"
_DEVICE = torch.device("cpu")  # hardcoded — never torch.cuda.is_available()

_SR = 22050  # f0_condition=False for this checkpoint (config_dit_mel_seed_uvit_xlsr_tiny.yml)
_HOP_LENGTH = 256
_MAX_REF_SECONDS = 25
_OVERLAP_FRAME_LEN = 16


def _ensure_vendor_on_path() -> None:
    if str(_VENDOR_ROOT) not in sys.path:
        sys.path.insert(0, str(_VENDOR_ROOT))


class SeedVCVoiceEngine(VoiceConversionEngine):
    def __init__(self, settings: Settings):
        self._settings = settings
        self._state = EngineState.NOT_LOADED
        self._error_detail: str | None = None
        self._model = None
        self._semantic_fn = None
        self._campplus_model = None
        self._vocoder_fn = None
        self._mel_fn = None
        self._artifact_cache: dict[str, tuple] = {}
        self.profiler: Profiler = NULL_PROFILER

    def set_profiler(self, profiler: Profiler | None) -> None:
        """Opt-in stage timing — see app/audio/profiling.py. Never enabled by
        default; a caller (the CLI's --profile flag, or a test) turns it on
        explicitly. Passing None resets to the no-op profiler."""
        self.profiler = profiler or NULL_PROFILER

    # -- lifecycle ---------------------------------------------------

    def load(self) -> None:
        if self._state in (EngineState.READY, EngineState.WARMING_UP, EngineState.CONVERTING):
            return
        self._state = EngineState.LOADING
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # belt-and-suspenders CPU enforcement
        torch.set_grad_enabled(False)
        if self._settings.torch_num_threads:
            torch.set_num_threads(self._settings.torch_num_threads)
        _ensure_vendor_on_path()
        try:
            self._load_model_bundle()
        except AIEngineError:
            self._state = EngineState.ERROR
            raise
        except Exception as exc:
            self._state = EngineState.ERROR
            self._error_detail = str(exc)
            raise AIEngineError(AIErrorCode.MODEL_LOAD_FAILED, f"Failed to load seed-vc: {exc}") from exc
        self._state = EngineState.READY

    def warmup(self) -> None:
        if self._state != EngineState.READY:
            self.load()
        self._state = EngineState.WARMING_UP
        try:
            silence = np.zeros(_SR // 2, dtype="float32")
            waves_16k = torchaudio.functional.resample(torch.tensor(silence).unsqueeze(0), _SR, 16000)
            with torch.no_grad():
                self._semantic_fn(waves_16k)
        except Exception as exc:  # warmup failures are non-fatal, just logged
            logger.warning("Warmup pass failed (continuing): %s", exc)
        finally:
            self._state = EngineState.READY

    def unload(self) -> None:
        self._model = None
        self._semantic_fn = None
        self._campplus_model = None
        self._vocoder_fn = None
        self._mel_fn = None
        self._artifact_cache.clear()
        self._state = EngineState.NOT_LOADED

    def health_check(self) -> EngineHealth:
        return EngineHealth(
            state=self._state,
            device="cpu",
            engine_name="seed_vc",
            model_name=self._settings.seed_vc_checkpoint_file,
            model_version=self._settings.seed_vc_model_version,
            configured=True,
            loaded=self._state in (EngineState.READY, EngineState.CONVERTING),
            detail=self._error_detail,
        )

    # -- model loading -------------------------------------------------

    def _download(self, repo_id: str, filename: str) -> Path:
        cache_dir = self._settings.model_cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            path = hf_hub_download(repo_id=repo_id, filename=filename, cache_dir=str(cache_dir))
        except Exception as exc:
            raise AIEngineError(
                AIErrorCode.MODEL_DOWNLOAD_FAILED, f"Failed to download {repo_id}/{filename}: {exc}"
            ) from exc
        return Path(path)

    def _write_manifest(self, checkpoint_path: Path) -> None:
        import hashlib

        sha256 = hashlib.sha256()
        with open(checkpoint_path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                sha256.update(block)
        manifest = {
            "name": self._settings.seed_vc_model_version,
            "version": self._settings.seed_vc_model_version,
            "source": f"https://huggingface.co/{self._settings.seed_vc_model_repo}",
            "license": "GPL-3.0 (code and weights) — see docs/model-selection.md",
            "checksum": f"sha256:{sha256.hexdigest()}",
            "size": checkpoint_path.stat().st_size,
        }
        self._settings.model_dir.mkdir(parents=True, exist_ok=True)
        (self._settings.model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    def _load_model_bundle(self) -> None:
        from modules.campplus.DTDNN import CAMPPlus
        from modules.commons import build_model, load_checkpoint, recursive_munch
        from modules.hifigan.f0_predictor import ConvRNNF0Predictor
        from modules.hifigan.generator import HiFTGenerator

        dit_checkpoint_path = self._download(
            self._settings.seed_vc_model_repo, self._settings.seed_vc_checkpoint_file
        )
        dit_config_path = self._download(
            self._settings.seed_vc_model_repo, self._settings.seed_vc_config_file
        )
        self._write_manifest(dit_checkpoint_path)

        config = yaml.safe_load(open(dit_config_path))
        model_params = recursive_munch(config["model_params"])
        model_params.dit_type = "DiT"
        model = build_model(model_params, stage="DiT")
        model, _, _, _ = load_checkpoint(
            model,
            None,
            str(dit_checkpoint_path),
            load_only_params=True,
            ignore_modules=[],
            is_distributed=False,
        )
        for key in model:
            model[key].eval()
            model[key].to(_DEVICE)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
        self._model = model

        # Speech tokenizer: xlsr (facebook/wav2vec2-xls-r-300m), kept in
        # float32 throughout — the upstream script's `.half()` call here is
        # exactly what's unsafe on CPU; we never call it.
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model

        tok_cfg = model_params.speech_tokenizer
        hf_cache_dir = str(self._settings.model_cache_dir)
        feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(tok_cfg.name, cache_dir=hf_cache_dir)
        wav2vec_model = Wav2Vec2Model.from_pretrained(tok_cfg.name, cache_dir=hf_cache_dir)
        wav2vec_model.encoder.layers = wav2vec_model.encoder.layers[: tok_cfg.output_layer]
        wav2vec_model = wav2vec_model.to(_DEVICE).eval()

        def semantic_fn(waves_16k: torch.Tensor) -> torch.Tensor:
            inputs = feature_extractor(
                [waves_16k[b].cpu().numpy() for b in range(len(waves_16k))],
                return_tensors="pt",
                return_attention_mask=True,
                padding=True,
                sampling_rate=16000,
            ).to(_DEVICE)
            with torch.no_grad():
                outputs = wav2vec_model(inputs.input_values)
            return outputs.last_hidden_state.float()

        self._semantic_fn = semantic_fn

        # Speaker/style encoder — a real, vendored local file, not an HF download.
        campplus_ckpt_path = _VENDOR_ROOT / "campplus_cn_common.bin"
        if not campplus_ckpt_path.exists():
            raise AIEngineError(AIErrorCode.MODEL_NOT_FOUND, f"Missing {campplus_ckpt_path}")
        campplus_model = CAMPPlus(feat_dim=80, embedding_size=192)
        campplus_model.load_state_dict(torch.load(campplus_ckpt_path, map_location="cpu"))
        campplus_model.eval().to(_DEVICE)
        self._campplus_model = campplus_model

        # Vocoder: HiFTGenerator (vocoder.type == "hifigan" for this checkpoint).
        hift_config_path = _VENDOR_ROOT / "configs" / "hifigan.yml"
        hift_config = yaml.safe_load(open(hift_config_path))
        hift_gen = HiFTGenerator(
            **hift_config["hift"], f0_predictor=ConvRNNF0Predictor(**hift_config["f0_predictor"])
        )
        hift_path = self._download("FunAudioLLM/CosyVoice-300M", "hift.pt")
        hift_gen.load_state_dict(torch.load(hift_path, map_location="cpu"))
        hift_gen.eval().to(_DEVICE)
        self._vocoder_fn = hift_gen

        from modules.audio import mel_spectrogram

        mel_fn_args = {
            "n_fft": config["preprocess_params"]["spect_params"]["n_fft"],
            "win_size": config["preprocess_params"]["spect_params"]["win_length"],
            "hop_size": config["preprocess_params"]["spect_params"]["hop_length"],
            "num_mels": config["preprocess_params"]["spect_params"]["n_mels"],
            "sampling_rate": config["preprocess_params"]["sr"],
            "fmin": config["preprocess_params"]["spect_params"].get("fmin", 0),
            "fmax": 8000,
            "center": False,
        }
        self._mel_fn = lambda x: mel_spectrogram(x, **mel_fn_args)

    # -- target preparation -------------------------------------------

    def prepare_target_voice(
        self, reference_files: list, artifact_path: Path, max_reference_seconds: float | None = None
    ) -> str:
        if self._state not in (
            EngineState.READY,
            EngineState.CONVERTING,
            EngineState.WARMING_UP,
            EngineState.STREAMING,
        ):
            self.load()
        import librosa

        ref_cap_seconds = max_reference_seconds if max_reference_seconds is not None else _MAX_REF_SECONDS
        try:
            with self.profiler.stage("decode_references"):
                waves = [librosa.load(str(p), sr=_SR)[0] for p in reference_files]
                ref_audio_np = np.concatenate(waves)[: int(_SR * ref_cap_seconds)]
                ref_audio = torch.tensor(ref_audio_np).unsqueeze(0).float().to(_DEVICE)
                ori_waves_16k = torchaudio.functional.resample(ref_audio, _SR, 16000)

            with torch.no_grad():
                with self.profiler.stage("xlsr_feature_extraction"):
                    S_ori = self._semantic_fn(ori_waves_16k)
                with self.profiler.stage("mel_spectrogram"):
                    mel2 = self._mel_fn(ref_audio.float())
                    target2_lengths = torch.LongTensor([mel2.size(2)])

                with self.profiler.stage("campplus_speaker_conditioning"):
                    feat2 = torchaudio.compliance.kaldi.fbank(
                        ori_waves_16k, num_mel_bins=80, dither=0, sample_frequency=16000
                    )
                    feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
                    style2 = self._campplus_model(feat2.unsqueeze(0))

                with self.profiler.stage("length_regulator"):
                    prompt_condition, *_ = self._model.length_regulator(
                        S_ori, ylens=target2_lengths, n_quantizers=3, f0=None
                    )
        except Exception as exc:
            raise AIEngineError(
                AIErrorCode.TARGET_VOICE_PREPARATION_FAILED, f"Failed to prepare target voice: {exc}"
            ) from exc

        prepared_voice_id = f"seedvc-{abs(hash(ref_audio_np.tobytes())) % (10**12):012d}"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "prepared_voice_id": prepared_voice_id,
                "prompt_condition": prompt_condition,
                "mel2": mel2,
                "style2": style2,
            },
            artifact_path,
        )
        return prepared_voice_id

    def _load_artifact(self, artifact_path: Path) -> dict:
        key = str(artifact_path)
        cached = self._artifact_cache.get(key)
        if cached is not None:
            return cached
        if not artifact_path.exists():
            raise AIEngineError(AIErrorCode.TARGET_VOICE_NOT_READY, f"No prepared voice at {artifact_path}")
        data = torch.load(artifact_path, map_location="cpu", weights_only=False)
        self._artifact_cache[key] = data
        return data

    # -- conversion ------------------------------------------------------

    def _run_diffusion_and_vocode(self, cond, prompt_condition, mel2, style2) -> np.ndarray:
        diffusion_steps = self._settings.seed_vc_diffusion_steps
        max_context_window = _SR // _HOP_LENGTH * 30
        overlap_wave_len = _OVERLAP_FRAME_LEN * _HOP_LENGTH
        max_source_window = max_context_window - mel2.size(2)

        processed_frames = 0
        chunks: list[np.ndarray] = []
        previous_chunk = None
        while processed_frames < cond.size(1):
            chunk_cond = cond[:, processed_frames : processed_frames + max_source_window]
            is_last_chunk = processed_frames + max_source_window >= cond.size(1)
            cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
            with torch.no_grad():
                vc_target = self._model.cfm.inference(
                    cat_condition,
                    torch.LongTensor([cat_condition.size(1)]),
                    mel2,
                    style2,
                    None,
                    diffusion_steps,
                    inference_cfg_rate=0.7,
                )
                vc_target = vc_target[:, :, mel2.size(-1) :]
            vc_wave = self._vocoder_fn(vc_target.float()).squeeze()[None, :]

            if previous_chunk is None:
                if is_last_chunk:
                    chunks.append(vc_wave[0].cpu().numpy())
                    break
                chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
                previous_chunk = vc_wave[0, -overlap_wave_len:]
                processed_frames += vc_target.size(2) - _OVERLAP_FRAME_LEN
            else:
                from app.audio.continuity import equal_power_crossfade

                if is_last_chunk:
                    chunks.append(
                        equal_power_crossfade(
                            previous_chunk.cpu().numpy(), vc_wave[0].cpu().numpy(), overlap_wave_len
                        )
                    )
                    processed_frames += vc_target.size(2) - _OVERLAP_FRAME_LEN
                    break
                blended = equal_power_crossfade(
                    previous_chunk.cpu().numpy(),
                    vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                    overlap_wave_len,
                )
                chunks.append(blended)
                previous_chunk = vc_wave[0, -overlap_wave_len:]
                processed_frames += vc_target.size(2) - _OVERLAP_FRAME_LEN
        return np.concatenate(chunks)

    def convert_file(
        self, source_audio: Path, prepared_voice_path: Path, output_path: Path
    ) -> ConversionMetrics:
        if self._state not in (EngineState.READY, EngineState.WARMING_UP):
            self.load()
        self._state = EngineState.CONVERTING
        try:
            import librosa

            with self.profiler.stage("load_artifact"):
                artifact = self._load_artifact(prepared_voice_path)
            with self.profiler.stage("decode_source"):
                source_np, _ = librosa.load(str(source_audio), sr=_SR)
                source_duration = len(source_np) / _SR
                source_audio_t = torch.tensor(source_np).unsqueeze(0).float().to(_DEVICE)

            start = time.monotonic()
            with torch.no_grad():
                with self.profiler.stage("resample_16k"):
                    waves_16k = torchaudio.functional.resample(source_audio_t, _SR, 16000)
                with self.profiler.stage("xlsr_feature_extraction"):
                    S_alt = self._semantic_fn(waves_16k)
                with self.profiler.stage("mel_spectrogram"):
                    mel = self._mel_fn(source_audio_t.float())
                with self.profiler.stage("length_regulator"):
                    target_lengths = torch.LongTensor([mel.size(2)])
                    cond, *_ = self._model.length_regulator(
                        S_alt, ylens=target_lengths, n_quantizers=3, f0=None
                    )

                with self.profiler.stage("diffusion_and_vocoder"):
                    output = self._run_diffusion_and_vocode(
                        cond, artifact["prompt_condition"], artifact["mel2"], artifact["style2"]
                    )
            elapsed = time.monotonic() - start

            from app.audio.postprocessing import write_wav

            write_wav(output_path, output, _SR)
            return ConversionMetrics(
                processing_time_seconds=elapsed,
                source_duration_seconds=source_duration,
                output_duration_seconds=len(output) / _SR,
                output_sample_rate=_SR,
                prepared_voice_id=artifact.get("prepared_voice_id", ""),
                diffusion_steps=30,
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
        """Independent per-chunk conversion — each call runs the full semantic
        -> diffusion -> vocoder pipeline on exactly the audio it's given, with
        no cross-chunk context. Used directly by the offline chunked-
        conversion benchmark (Phase 3 Step 5); the resident engine's
        StreamSession (Phase 3.1) calls this with a context-extended window
        instead of the raw chunk — see _SeedVCStreamSession. Every stage is
        timed via self.profiler when profiling is enabled (see
        docs/phase3-ai-conversion.md "Profiling Results").
        """
        if self._state not in (EngineState.READY, EngineState.WARMING_UP, EngineState.STREAMING):
            self.load()
        with self.profiler.stage("load_artifact"):
            artifact = self._load_artifact(prepared_voice_path)

        with self.profiler.stage("resample_input"):
            if sample_rate != _SR:
                chunk_t = (
                    torch.tensor(torchaudio_resample_np(audio_chunk, sample_rate, _SR)).unsqueeze(0).float()
                )
            else:
                chunk_t = torch.tensor(audio_chunk).unsqueeze(0).float().to(_DEVICE)

        with torch.no_grad():
            with self.profiler.stage("resample_16k"):
                waves_16k = torchaudio.functional.resample(chunk_t, _SR, 16000)
            with self.profiler.stage("xlsr_feature_extraction"):
                S_alt = self._semantic_fn(waves_16k)
            with self.profiler.stage("mel_spectrogram"):
                mel = self._mel_fn(chunk_t.float())
            with self.profiler.stage("length_regulator"):
                target_lengths = torch.LongTensor([mel.size(2)])
                cond, *_ = self._model.length_regulator(S_alt, ylens=target_lengths, n_quantizers=3, f0=None)
            with self.profiler.stage("diffusion"):
                cat_condition = torch.cat([artifact["prompt_condition"], cond], dim=1)
                vc_target = self._model.cfm.inference(
                    cat_condition,
                    torch.LongTensor([cat_condition.size(1)]),
                    artifact["mel2"],
                    artifact["style2"],
                    None,
                    self._settings.seed_vc_diffusion_steps,
                    inference_cfg_rate=0.7,
                )
                vc_target = vc_target[:, :, artifact["mel2"].size(-1) :]
            with self.profiler.stage("vocoder"):
                vc_wave = self._vocoder_fn(vc_target.float()).squeeze().cpu().numpy()
        return vc_wave

    def create_stream(
        self, prepared_voice_path: Path, context_seconds: float | None = None, overlap_ms: int | None = None
    ) -> StreamSession:
        return _SeedVCStreamSession(
            self,
            prepared_voice_path,
            context_seconds=(
                context_seconds if context_seconds is not None else self._settings.stream_context_seconds
            ),
            overlap_ms=overlap_ms if overlap_ms is not None else self._settings.stream_overlap_ms,
        )


def torchaudio_resample_np(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    t = torch.tensor(audio).unsqueeze(0).float()
    return torchaudio.functional.resample(t, orig_sr, target_sr).squeeze(0).numpy()


class _SeedVCStreamSession(StreamSession):
    """In-process streaming session (see engines/base.py:StreamSession).

    Phase 3.1 context reuse (Step 9): each call prepends up to
    `context_seconds` of previously-seen INPUT audio to the new chunk before
    running the full pipeline, then emits only the portion of the output
    corresponding to the new chunk — this is a real, measured continuity
    improvement (the model sees real trailing audio instead of a cold
    boundary), NOT a cost reduction. Profiling (Phase 3.1 Step 2) found the
    model's per-call cost is dominated by the diffusion step over the
    reference/prompt condition length, not the chunk's own length — so a
    larger context here trades a small amount of extra latency for better
    continuity, it does not make chunks cheaper. See
    docs/phase3.1-resident-engine.md "Context Reuse".

    Crossfades the emitted region's leading edge against the previous
    chunk's trailing tail, same as the offline chunked harness.
    """

    def __init__(
        self,
        engine: SeedVCVoiceEngine,
        prepared_voice_path: Path,
        context_seconds: float = 0.5,
        overlap_ms: int = 40,
    ):
        self._engine = engine
        self._prepared_voice_path = prepared_voice_path
        self._context_seconds = context_seconds
        self._previous_tail: np.ndarray | None = None
        self._overlap_samples = int(_SR * overlap_ms / 1000)
        self._context_buffer = np.zeros(0, dtype="float32")

    def process(self, audio_chunk: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
        from app.audio.continuity import equal_power_crossfade

        if sample_rate != _SR:
            audio_chunk = torchaudio_resample_np(audio_chunk, sample_rate, _SR)

        context_len = len(self._context_buffer)
        windowed_input = np.concatenate([self._context_buffer, audio_chunk]).astype("float32")

        full_output = self._engine.process_chunk(windowed_input, _SR, self._prepared_voice_path)

        # Emit only the portion of the output attributable to the new chunk —
        # approximated by the input-duration ratio, since Seed-VC preserves
        # timing closely (frame-quantized by hop_length=256, not exact).
        if context_len > 0 and len(windowed_input) > 0:
            new_fraction = len(audio_chunk) / len(windowed_input)
            skip_samples = len(full_output) - round(len(full_output) * new_fraction)
            output = full_output[skip_samples:]
        else:
            output = full_output

        if self._previous_tail is not None and len(output) > 0:
            output = equal_power_crossfade(self._previous_tail, output, self._overlap_samples)
        if len(output) >= self._overlap_samples:
            self._previous_tail = output[-self._overlap_samples :]

        max_context_samples = int(_SR * self._context_seconds)
        self._context_buffer = (
            windowed_input[-max_context_samples:] if max_context_samples > 0 else np.zeros(0, dtype="float32")
        )

        return output, _SR

    def close(self) -> None:
        self._previous_tail = None
        self._context_buffer = np.zeros(0, dtype="float32")
