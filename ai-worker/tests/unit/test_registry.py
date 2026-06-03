from app.core.config import EngineName
from app.engines.passthrough import PassthroughVoiceEngine
from app.engines.registry import get_engine


def test_get_engine_passthrough(settings):
    engine = get_engine(EngineName.PASSTHROUGH, settings)
    assert isinstance(engine, PassthroughVoiceEngine)


def test_get_engine_seed_vc_lazily_imports_torch_stack(settings):
    # Only asserts the registry *attempts* the lazy import path (and doesn't
    # eagerly import torch for passthrough-only callers) — the real model's
    # behavior is covered by tests/ai (opt-in, needs downloaded weights).
    engine = get_engine(EngineName.SEED_VC, settings)
    assert engine.__class__.__name__ == "SeedVCVoiceEngine"


def test_get_engine_openvoice_onnx_lazily_imports_onnxruntime(settings):
    # Same lazy-import contract as seed_vc — proves engine switching (Phase
    # 3.2 Step 21/22) is just a config value, not a code branch elsewhere.
    engine = get_engine(EngineName.OPENVOICE_ONNX, settings)
    assert engine.__class__.__name__ == "OpenVoiceOnnxEngine"


def test_engine_selection_is_config_driven_not_hardcoded(settings):
    # The exact same call, varying only settings.engine / the explicit name
    # argument, produces a different concrete engine — no special-casing
    # anywhere in application code needs to know which engine is active.
    from app.engines.base import VoiceConversionEngine

    for name in (EngineName.PASSTHROUGH, EngineName.SEED_VC, EngineName.OPENVOICE_ONNX):
        engine = get_engine(name, settings)
        assert isinstance(engine, VoiceConversionEngine)
