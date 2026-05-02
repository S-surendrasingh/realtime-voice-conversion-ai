"""Real Seed-VC smoke tests — download real weights and run real CPU
inference. NOT run by default (see pyproject.toml addopts); run explicitly
with `pytest -m ai`. Uses the example clips bundled with vendor/seed-vc
(examples/source/source_s1.wav, examples/reference/s1p1.wav) — the same
files used for the manual benchmark runs in docs/phase3-ai-conversion.md.
"""

from pathlib import Path

import pytest

from app.core.config import Settings
from app.engines.base import EngineState
from app.engines.seed_vc import SeedVCVoiceEngine

_VENDOR_EXAMPLES = Path(__file__).resolve().parents[2] / "vendor" / "seed-vc" / "examples"
_SOURCE = _VENDOR_EXAMPLES / "source" / "source_s1.wav"
_REFERENCE = _VENDOR_EXAMPLES / "reference" / "s1p1.wav"

pytestmark = [
    pytest.mark.ai,
    pytest.mark.skipif(not _SOURCE.exists(), reason="vendor/seed-vc examples not present"),
]


@pytest.fixture(scope="module")
def loaded_engine():
    engine = SeedVCVoiceEngine(Settings(_env_file=None, seed_vc_diffusion_steps=4))
    engine.load()
    yield engine
    engine.unload()


def test_health_check_reports_ready_after_load(loaded_engine):
    health = loaded_engine.health_check()
    assert health.state == EngineState.READY
    assert health.device == "cpu"
    assert health.loaded is True


def test_offline_conversion_produces_valid_playable_output(loaded_engine, tmp_path):
    artifact = tmp_path / "target.pt"
    loaded_engine.prepare_target_voice([_REFERENCE], artifact)

    output = tmp_path / "converted.wav"
    metrics = loaded_engine.convert_file(_SOURCE, artifact, output)

    assert output.exists()
    assert output.stat().st_size > 0
    assert metrics.output_duration_seconds > 0
    assert metrics.rtf > 0

    import soundfile as sf

    audio, sr = sf.read(output)
    assert sr == metrics.output_sample_rate
    assert len(audio) > 0


def test_manifest_is_written_with_license_and_checksum(loaded_engine):
    settings = loaded_engine._settings  # noqa: SLF001 - test-only introspection
    manifest_path = settings.model_dir / "manifest.json"
    assert manifest_path.exists()

    import json

    manifest = json.loads(manifest_path.read_text())
    assert manifest["checksum"].startswith("sha256:")
    assert "GPL-3.0" in manifest["license"]
    assert manifest["size"] > 0
