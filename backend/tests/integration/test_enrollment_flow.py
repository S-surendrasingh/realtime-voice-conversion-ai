import pytest

from tests.audio_fixtures import make_wav_bytes

pytestmark = pytest.mark.asyncio

VOICES = "/api/v1/voices"


async def test_full_enrollment_happy_path(client) -> None:
    create_response = await client.post(
        VOICES,
        json={
            "name": "Person A",
            "description": "My target voice profile",
            "consent_confirmed": True,
        },
    )
    assert create_response.status_code == 201
    profile = create_response.json()
    assert profile["status"] == "RECORDING"
    profile_id = profile["id"]

    for i in range(3):
        upload_response = await client.post(
            f"{VOICES}/{profile_id}/samples",
            files={
                "file": (
                    f"sample-{i:02d}.wav",
                    make_wav_bytes(duration_seconds=12.0 + i),
                    "audio/wav",
                )
            },
        )
        assert upload_response.status_code == 201
        assert upload_response.json()["status"] == "VALID"

    profile_response = await client.get(f"{VOICES}/{profile_id}")
    profile_body = profile_response.json()
    assert profile_body["sample_count"] == 3
    assert profile_body["valid_sample_count"] == 3
    assert profile_body["total_duration_seconds"] == pytest.approx(12 + 13 + 14, abs=0.1)

    complete_response = await client.post(f"{VOICES}/{profile_id}/complete")
    assert complete_response.status_code == 200
    complete_body = complete_response.json()
    assert complete_body["status"] == "READY_FOR_AI_PROCESSING"
    assert complete_body["valid_sample_count"] == 3

    final_profile = await client.get(f"{VOICES}/{profile_id}")
    assert final_profile.json()["status"] == "READY_FOR_AI_PROCESSING"


async def test_enrollment_blocked_until_enough_valid_samples(client) -> None:
    create_response = await client.post(
        VOICES, json={"name": "Person A", "consent_confirmed": True}
    )
    profile_id = create_response.json()["id"]

    await client.post(
        f"{VOICES}/{profile_id}/samples",
        files={"file": ("valid-1.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
    )
    await client.post(
        f"{VOICES}/{profile_id}/samples",
        files={"file": ("too-short.wav", make_wav_bytes(duration_seconds=1.0), "audio/wav")},
    )

    blocked_response = await client.post(f"{VOICES}/{profile_id}/complete")
    assert blocked_response.status_code == 400

    await client.post(
        f"{VOICES}/{profile_id}/samples",
        files={"file": ("valid-2.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
    )
    await client.post(
        f"{VOICES}/{profile_id}/samples",
        files={"file": ("valid-3.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
    )

    ready_response = await client.post(f"{VOICES}/{profile_id}/complete")
    assert ready_response.status_code == 200
    assert ready_response.json()["status"] == "READY_FOR_AI_PROCESSING"


async def test_deleting_a_sample_can_drop_below_completion_threshold(client) -> None:
    create_response = await client.post(
        VOICES, json={"name": "Person A", "consent_confirmed": True}
    )
    profile_id = create_response.json()["id"]

    sample_ids = []
    for i in range(3):
        response = await client.post(
            f"{VOICES}/{profile_id}/samples",
            files={"file": (f"s{i}.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
        )
        sample_ids.append(response.json()["id"])

    await client.delete(f"{VOICES}/{profile_id}/samples/{sample_ids[0]}")

    response = await client.post(f"{VOICES}/{profile_id}/complete")
    assert response.status_code == 400
