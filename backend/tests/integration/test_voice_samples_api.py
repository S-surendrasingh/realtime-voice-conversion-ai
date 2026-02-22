import uuid

import pytest

from tests.audio_fixtures import make_wav_bytes

pytestmark = pytest.mark.asyncio

VOICES = "/api/v1/voices"


async def _create_profile(client) -> str:
    response = await client.post(VOICES, json={"name": "Person A", "consent_confirmed": True})
    return response.json()["id"]


def _samples_url(profile_id: str, suffix: str = "") -> str:
    return f"{VOICES}/{profile_id}/samples{suffix}"


async def test_upload_valid_sample_is_marked_valid(client) -> None:
    profile_id = await _create_profile(client)
    content = make_wav_bytes(duration_seconds=10.0)

    response = await client.post(
        _samples_url(profile_id),
        files={"file": ("sample-01.wav", content, "audio/wav")},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "VALID"
    assert body["validation_error"] is None
    assert body["sample_rate"] == 44100
    assert body["channels"] == 1
    assert body["duration_seconds"] == pytest.approx(10.0, abs=0.01)
    assert body["original_filename"] == "sample-01.wav"
    assert "storage_key" not in body


async def test_upload_too_short_sample_is_marked_invalid(client) -> None:
    profile_id = await _create_profile(client)
    content = make_wav_bytes(duration_seconds=1.0)

    response = await client.post(
        _samples_url(profile_id),
        files={"file": ("too-short.wav", content, "audio/wav")},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "INVALID"
    assert "shorter than the minimum" in body["validation_error"]


async def test_upload_corrupt_file_is_marked_invalid(client) -> None:
    profile_id = await _create_profile(client)

    response = await client.post(
        _samples_url(profile_id),
        files={"file": ("corrupt.wav", b"not actually audio" * 10, "audio/wav")},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "INVALID"
    assert "corrupt" in body["validation_error"].lower()


async def test_upload_unsupported_format_is_marked_invalid(client) -> None:
    profile_id = await _create_profile(client)
    content = make_wav_bytes(duration_seconds=10.0)

    response = await client.post(
        _samples_url(profile_id),
        files={"file": ("sample.mp3", content, "audio/mpeg")},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "INVALID"
    assert "Unsupported file extension" in body["validation_error"]


async def test_upload_to_unknown_profile_returns_404(client) -> None:
    content = make_wav_bytes(duration_seconds=10.0)
    response = await client.post(
        _samples_url(str(uuid.uuid4())),
        files={"file": ("sample.wav", content, "audio/wav")},
    )
    assert response.status_code == 404


async def test_list_samples_returns_uploaded_samples(client) -> None:
    profile_id = await _create_profile(client)
    for i in range(2):
        await client.post(
            _samples_url(profile_id),
            files={"file": (f"sample-{i}.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
        )

    response = await client.get(_samples_url(profile_id))

    assert response.status_code == 200
    assert len(response.json()) == 2


async def test_get_single_sample(client) -> None:
    profile_id = await _create_profile(client)
    upload_response = await client.post(
        _samples_url(profile_id),
        files={"file": ("sample.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
    )
    sample_id = upload_response.json()["id"]

    response = await client.get(_samples_url(profile_id, f"/{sample_id}"))

    assert response.status_code == 200
    assert response.json()["id"] == sample_id


async def test_get_sample_returns_404_for_unknown_sample(client) -> None:
    profile_id = await _create_profile(client)
    response = await client.get(_samples_url(profile_id, f"/{uuid.uuid4()}"))
    assert response.status_code == 404


async def test_delete_sample_removes_it_from_listing(client) -> None:
    profile_id = await _create_profile(client)
    upload_response = await client.post(
        _samples_url(profile_id),
        files={"file": ("sample.wav", make_wav_bytes(duration_seconds=10.0), "audio/wav")},
    )
    sample_id = upload_response.json()["id"]

    delete_response = await client.delete(_samples_url(profile_id, f"/{sample_id}"))
    assert delete_response.status_code == 204

    get_response = await client.get(_samples_url(profile_id, f"/{sample_id}"))
    assert get_response.status_code == 404

    list_response = await client.get(_samples_url(profile_id))
    assert list_response.json() == []


async def test_delete_unknown_sample_returns_404(client) -> None:
    profile_id = await _create_profile(client)
    response = await client.delete(_samples_url(profile_id, f"/{uuid.uuid4()}"))
    assert response.status_code == 404


async def test_get_sample_audio_returns_original_bytes(client) -> None:
    profile_id = await _create_profile(client)
    content = make_wav_bytes(duration_seconds=10.0)
    upload_response = await client.post(
        _samples_url(profile_id),
        files={"file": ("sample.wav", content, "audio/wav")},
    )
    sample_id = upload_response.json()["id"]

    response = await client.get(_samples_url(profile_id, f"/{sample_id}/audio"))

    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"] == "audio/wav"


async def test_get_sample_audio_returns_404_for_unknown_sample(client) -> None:
    profile_id = await _create_profile(client)
    response = await client.get(_samples_url(profile_id, f"/{uuid.uuid4()}/audio"))
    assert response.status_code == 404


async def test_get_sample_audio_returns_404_for_unknown_profile(client) -> None:
    response = await client.get(_samples_url(str(uuid.uuid4()), f"/{uuid.uuid4()}/audio"))
    assert response.status_code == 404
