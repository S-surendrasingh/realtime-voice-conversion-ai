"""Real OpenVoice ONNX smoke test — downloads the real community ONNX
export and runs real CPU inference. NOT run by default; run explicitly with
`pytest -m ai`. Uses the same bundled example clips as the Seed-VC smoke
test for a genuine apples-to-apples comparison.
"""

from pathlib import Path

import pytest

from app.core.config import Settings
from app.engines.base import EngineState
from app.engines.openvoice_onnx import OpenVoiceOnnxEngine

_VENDOR_EXAMPLES = Path(__file__).resolve().parents[2] / "vendor" / "seed-vc" / "examples"
_SOURCE = _VENDOR_EXAMPLES / "source" / "source_s1.wav"
_REFERENCE = _VENDOR_EXAMPLES / "reference" / "s1p1.wav"

pytestmark = [
    pytest.mark.ai,
    pytest.mark.skipif(not _SOURCE.exists(), reason="vendor/seed-vc examples not present"),
]


@pytest.fixture(scope="module")
def loaded_engine():
    engine = OpenVoiceOnnxEngine(Settings(_env_file=None))
    engine.load()
    yield engine
    engine.unload()


def test_health_check_reports_ready_after_load(loaded_engine):
    health = loaded_engine.health_check()
    assert health.state == EngineState.READY
    assert health.device == "cpu"
    assert health.loaded is True


def test_offline_conversion_produces_valid_playable_output(loaded_engine, tmp_path):
    artifact = tmp_path / "target.npy"
    loaded_engine.prepare_target_voice([_REFERENCE], artifact)

    output = tmp_path / "converted.wav"
    metrics = loaded_engine.convert_file(_SOURCE, artifact, output)

    assert output.exists()
    assert output.stat().st_size > 0
    assert metrics.output_duration_seconds > 0
    assert metrics.rtf > 0
    assert metrics.rtf < 1.0  # the whole point of Phase 3.2 — verified, not assumed

    import soundfile as sf

    audio, sr = sf.read(output)
    assert sr == metrics.output_sample_rate
    assert len(audio) > 0


def test_manifest_is_written_with_license_and_checksum(loaded_engine):
    settings = loaded_engine._settings  # noqa: SLF001 - test-only introspection
    manifest_path = settings.model_cache_dir / settings.openvoice_model_version / "manifest.json"
    assert manifest_path.exists()

    import json

    manifest = json.loads(manifest_path.read_text())
    assert manifest["checksum"].startswith("sha256:")
    assert "MIT" in manifest["license"]
    assert manifest["size"] > 0
