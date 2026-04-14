from enum import Enum
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineName(str, Enum):
    PASSTHROUGH = "passthrough"
    SEED_VC = "seed_vc"
    OPENVOICE_ONNX = "openvoice_onnx"


class OrtGraphOptimizationLevel(str, Enum):
    DISABLE_ALL = "ORT_DISABLE_ALL"
    ENABLE_BASIC = "ORT_ENABLE_BASIC"
    ENABLE_EXTENDED = "ORT_ENABLE_EXTENDED"
    ENABLE_ALL = "ORT_ENABLE_ALL"


class Settings(BaseSettings):
    """Configuration for the AI worker. Every field is environment-driven
    (prefix AI_) so the backend/Docker can configure this process without
    code changes — mirrors backend/app/core/config.py's own conventions.
    """

    model_config = SettingsConfigDict(
        env_prefix="AI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Device: always CPU. There is no "cuda if available" branch
    # anywhere in this codebase — engines must not probe for a GPU. This
    # field exists so the value is visible in config/logs, not so a future
    # value could silently opt into GPU use.
    device: str = "cpu"

    engine: EngineName = EngineName.SEED_VC

    # Where downloaded model weights are cached. Never committed to git.
    model_cache_dir: Path = Path.home() / ".voiceshift" / "models"

    seed_vc_model_repo: str = "Plachta/Seed-VC"
    seed_vc_checkpoint_file: str = "DiT_uvit_tat_xlsr_ema.pth"
    seed_vc_config_file: str = "config_dit_mel_seed_uvit_xlsr_tiny.yml"
    seed_vc_model_version: str = "seed-uvit-tat-xlsr-tiny"
    # Diffusion steps traded directly against quality — see the measured
    # RTF-vs-steps comparison in docs/phase3-ai-conversion.md before
    # changing this default.
    seed_vc_diffusion_steps: int = 30

    # CPU thread count for torch. None lets torch pick its own default;
    # set explicitly to benchmark specific values (see docs/phase3-ai-conversion.md).
    torch_num_threads: int | None = None

    # Reference-selection budget (voices/preparation.py) — how much of the
    # enrolled Person A audio to actually hand to the engine.
    max_reference_samples: int = 3
    max_reference_duration_seconds: float = 90.0

    # Chunked-conversion defaults (audio/chunking.py).
    default_chunk_ms: int = 300
    default_overlap_ms: int = 40

    # --- Resident streaming engine (Phase 3.1) ---
    # Reference length used specifically when preparing a target voice for
    # STREAMING (resident engine load_voice) — deliberately much shorter
    # than the offline path's 25s cap. Discovered via real profiling: a
    # 14.6s reference made diffusion cost ~4s per 500ms chunk; a 3s
    # reference cut that to ~0.5-0.9s. See docs/phase3.1-resident-engine.md
    # "Root Cause". This is a real speed/quality tradeoff, not free —
    # shorter reference audio gives the model less of Person A's voice to
    # condition on.
    stream_reference_seconds: float = 3.0
    # How much previous input audio each new chunk is prepended with before
    # running the pipeline — improves continuity, does NOT reduce cost (see
    # same doc, "Context Reuse" — cost is dominated by reference length, not
    # chunk/context length).
    stream_context_seconds: float = 0.5
    stream_overlap_ms: int = 40
    # Bounded per-session queue depth for the resident server — see
    # docs/phase3.1-resident-engine.md "Backpressure".
    stream_max_queue_depth: int = 4

    server_host: str = "127.0.0.1"  # loopback only — see docs/phase3.1-resident-engine.md "IPC"
    server_port: int = 8765

    # --- OpenVoice V2 / ONNX Runtime (Phase 3.2) ---
    # A real, verified community ONNX export of the official MIT-licensed
    # myshell-ai/OpenVoiceV2 converter checkpoint (same architecture params —
    # sampling_rate/filter_length/hop_length/gin_channels all confirmed
    # identical to the official converter/config.json). See
    # docs/phase3.2-openvoice-onnx.md "ONNX Implementation" for how this was
    # verified before trusting it.
    openvoice_onnx_repo: str = "seasonstudio/openvoice_tone_clone_onnx"
    openvoice_tone_clone_file: str = "tone_clone_model.onnx"
    openvoice_tone_extract_file: str = "tone_color_extract_model.onnx"
    openvoice_model_version: str = "openvoice-v2-onnx"
    openvoice_sample_rate: int = 22050
    openvoice_tau: float = 0.3  # matches the official ToneColorConverter.convert() default

    # ONNX Runtime session config — centralized here, never scattered across
    # call sites (Phase 3.2 Step 6). CPUExecutionProvider only; no CUDA
    # provider is ever requested.
    ort_intra_op_num_threads: int | None = None
    ort_inter_op_num_threads: int | None = None
    ort_graph_optimization_level: OrtGraphOptimizationLevel = OrtGraphOptimizationLevel.ENABLE_ALL

    log_level: str = "INFO"

    @property
    def model_dir(self) -> Path:
        return self.model_cache_dir / self.seed_vc_model_version


@lru_cache
def get_settings() -> Settings:
    return Settings()
