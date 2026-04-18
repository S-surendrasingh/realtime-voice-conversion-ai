from app.core.config import EngineName, Settings
from app.engines.base import VoiceConversionEngine
from app.engines.passthrough import PassthroughVoiceEngine

_ENGINES: dict[EngineName, type[VoiceConversionEngine]] = {
    EngineName.PASSTHROUGH: PassthroughVoiceEngine,
}


def _seed_vc_engine_class() -> type[VoiceConversionEngine]:
    # Imported lazily: SeedVCVoiceEngine pulls in torch/transformers, which
    # PassthroughVoiceEngine-only callers (most unit tests, the passthrough
    # CLI path) shouldn't be forced to have installed.
    from app.engines.seed_vc import SeedVCVoiceEngine

    return SeedVCVoiceEngine


def _openvoice_onnx_engine_class() -> type[VoiceConversionEngine]:
    # Imported lazily: pulls in onnxruntime, which passthrough/seed_vc-only
    # callers shouldn't be forced to have installed.
    from app.engines.openvoice_onnx import OpenVoiceOnnxEngine

    return OpenVoiceOnnxEngine


_LAZY_ENGINES: dict[EngineName, "callable"] = {
    EngineName.SEED_VC: _seed_vc_engine_class,
    EngineName.OPENVOICE_ONNX: _openvoice_onnx_engine_class,
}


def get_engine(name: EngineName, settings: Settings) -> VoiceConversionEngine:
    lazy_ctor = _LAZY_ENGINES.get(name)
    if lazy_ctor is not None:
        return lazy_ctor()(settings)
    engine_cls = _ENGINES.get(name)
    if engine_cls is None:
        raise ValueError(f"Unknown engine: {name}")
    return engine_cls(settings)
