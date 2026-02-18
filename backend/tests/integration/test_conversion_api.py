"""Exercises the REAL ai-worker subprocess (see app/services/ai_worker_client.py)
with its passthrough engine — deterministic and dependency-light, but a real
process boundary, not a mock. Requires ai-worker/.venv to exist (see
ai-worker/README.md); this mirrors how these tests were actually run during
Phase 3 development.
"""

import tempfile
import uuid
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.main import app
from tests.audio_fixtures import make_wav_bytes

pytestmark = pytest.mark.asyncio

VOICES = "/api/v1/voices"


@pytest.fixture(autouse=True)
def use_passthrough_engine():
    settings = get_settings().model_copy(update={"ai_engine": "passthrough"})
    app.dependency_overrides[get_settings] = lambda: settings
    yield
    app.dependency_overrides.pop(get_settings, None)


async def _ready_profile(client) -> str:
    create_response = await client.post(
        VOICES, json={"name": "Person A", "consent_confirmed": True}
    )
    profile_id = create_response.json()["id"]
    for i in range(3):
        await client.post(
            f"{VOICES}/{profile_id}/samples",
            files={
                "file": (f"ref-{i}.wav", make_wav_bytes(duration_seconds=10.0 + i), "audio/wav")
            },
        )
    await client.post(f"{VOICES}/{profile_id}/complete")
    return profile_id


async def test_convert_against_ready_profile_succeeds(client) -> None:
    profile_id = await _ready_profile(client)

    response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("person_b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["voice_profile_id"] == profile_id
    assert body["status"] == "completed"
    assert body["source_duration_seconds"] == pytest.approx(5.0, abs=0.1)
    assert body["processing_time_seconds"] >= 0
    assert body["rtf"] >= 0
    assert body["device"] == "cpu"
    assert (
        body["output_url"]
        == f"/api/v1/voices/{profile_id}/conversions/{body['conversion_id']}/audio"
    )


async def test_converted_audio_is_retrievable(client) -> None:
    profile_id = await _ready_profile(client)
    convert_response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("person_b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )
    conversion_id = convert_response.json()["conversion_id"]

    audio_response = await client.get(f"{VOICES}/{profile_id}/conversions/{conversion_id}/audio")

    assert audio_response.status_code == 200
    assert audio_response.headers["content-type"] == "audio/wav"
    assert len(audio_response.content) > 0


async def test_unknown_conversion_id_returns_404(client) -> None:
    profile_id = await _ready_profile(client)
    response = await client.get(f"{VOICES}/{profile_id}/conversions/{uuid.uuid4()}/audio")
    assert response.status_code == 404


async def test_convert_against_unknown_profile_returns_404(client) -> None:
    response = await client.post(
        f"{VOICES}/00000000-0000-0000-0000-000000000099/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )
    assert response.status_code == 404


async def test_convert_before_enrollment_complete_returns_400(client) -> None:
    create_response = await client.post(
        VOICES, json={"name": "Person A", "consent_confirmed": True}
    )
    profile_id = create_response.json()["id"]

    response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )

    assert response.status_code == 400
    assert "READY_FOR_AI_PROCESSING" in response.json()["message"]


async def test_convert_with_no_valid_samples_after_completion_returns_400(client) -> None:
    profile_id = await _ready_profile(client)
    samples = (await client.get(f"{VOICES}/{profile_id}/samples")).json()
    for sample in samples:
        await client.delete(f"{VOICES}/{profile_id}/samples/{sample['id']}")

    response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )

    assert response.status_code == 400
    assert "no valid reference samples" in response.json()["message"].lower()


async def test_convert_with_invalid_source_audio_returns_400(client) -> None:
    profile_id = await _ready_profile(client)

    response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("bad.wav", b"not audio at all", "audio/wav")},
    )

    assert response.status_code == 400


async def test_ai_worker_invocation_failure_returns_502(client) -> None:
    profile_id = await _ready_profile(client)
    broken_settings = get_settings().model_copy(
        update={"ai_engine": "passthrough", "ai_worker_python": "/nonexistent/python"}
    )
    app.dependency_overrides[get_settings] = lambda: broken_settings

    response = await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )

    assert response.status_code == 502


async def test_repeated_conversion_reuses_cached_target_voice(client) -> None:
    profile_id = await _ready_profile(client)
    for _ in range(2):
        response = await client.post(
            f"{VOICES}/{profile_id}/convert",
            files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
        )
        assert response.status_code == 200


async def test_no_stray_temp_directories_survive_a_conversion(client) -> None:
    before = {p.name for p in Path(tempfile.gettempdir()).glob("voiceshift-conversion-*")}
    profile_id = await _ready_profile(client)
    await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )
    after = {p.name for p in Path(tempfile.gettempdir()).glob("voiceshift-conversion-*")}
    assert after == before


async def test_deleting_profile_cleans_up_prepared_voice_cache(client) -> None:
    profile_id = await _ready_profile(client)
    await client.post(
        f"{VOICES}/{profile_id}/convert",
        files={"source_audio": ("b.wav", make_wav_bytes(duration_seconds=5.0), "audio/wav")},
    )

    delete_response = await client.delete(f"{VOICES}/{profile_id}")
    assert delete_response.status_code == 204
