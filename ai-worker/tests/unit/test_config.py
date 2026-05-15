from app.core.config import EngineName, Settings


def test_device_is_always_cpu_by_default():
    assert Settings(_env_file=None).device == "cpu"


def test_default_engine_is_seed_vc():
    assert Settings(_env_file=None).engine == EngineName.SEED_VC


def test_env_prefix_is_ai(monkeypatch):
    monkeypatch.setenv("AI_ENGINE", "passthrough")
    monkeypatch.setenv("AI_MAX_REFERENCE_SAMPLES", "5")
    settings = Settings(_env_file=None)
    assert settings.engine == EngineName.PASSTHROUGH
    assert settings.max_reference_samples == 5


def test_model_dir_is_derived_from_cache_dir_and_version():
    settings = Settings(_env_file=None)
    assert settings.model_dir == settings.model_cache_dir / settings.seed_vc_model_version
