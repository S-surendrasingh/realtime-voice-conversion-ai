import uuid

import pytest

pytestmark = pytest.mark.asyncio

BASE = "/api/v1/voices"


async def test_create_voice_profile_requires_consent(client) -> None:
    response = await client.post(
        BASE, json={"name": "Person A", "description": "Target voice", "consent_confirmed": False}
    )
    assert response.status_code == 422


async def test_create_voice_profile_succeeds_with_consent(client) -> None:
    response = await client.post(
        BASE, json={"name": "Person A", "description": "Target voice", "consent_confirmed": True}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Person A"
    assert body["status"] == "RECORDING"
    assert body["consent_confirmed"] is True
    assert body["consent_confirmed_at"] is not None
    assert body["sample_count"] == 0
    assert body["valid_sample_count"] == 0


async def test_list_voice_profiles_returns_created_profiles(client) -> None:
    await client.post(BASE, json={"name": "Profile 1", "consent_confirmed": True})
    await client.post(BASE, json={"name": "Profile 2", "consent_confirmed": True})

    response = await client.get(BASE)

    assert response.status_code == 200
    names = {profile["name"] for profile in response.json()}
    assert {"Profile 1", "Profile 2"}.issubset(names)


async def test_get_voice_profile_returns_404_for_unknown_id(client) -> None:
    response = await client.get(f"{BASE}/{uuid.uuid4()}")
    assert response.status_code == 404


async def test_get_voice_profile_returns_created_profile(client) -> None:
    create_response = await client.post(BASE, json={"name": "Person A", "consent_confirmed": True})
    profile_id = create_response.json()["id"]

    response = await client.get(f"{BASE}/{profile_id}")

    assert response.status_code == 200
    assert response.json()["id"] == profile_id


async def test_update_voice_profile_changes_name_and_description(client) -> None:
    create_response = await client.post(BASE, json={"name": "Old Name", "consent_confirmed": True})
    profile_id = create_response.json()["id"]

    response = await client.patch(
        f"{BASE}/{profile_id}", json={"name": "New Name", "description": "Updated"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "New Name"
    assert body["description"] == "Updated"


async def test_delete_voice_profile_removes_it(client) -> None:
    create_response = await client.post(BASE, json={"name": "Person A", "consent_confirmed": True})
    profile_id = create_response.json()["id"]

    delete_response = await client.delete(f"{BASE}/{profile_id}")
    assert delete_response.status_code == 204

    get_response = await client.get(f"{BASE}/{profile_id}")
    assert get_response.status_code == 404


async def test_complete_enrollment_fails_without_enough_valid_samples(client) -> None:
    create_response = await client.post(BASE, json={"name": "Person A", "consent_confirmed": True})
    profile_id = create_response.json()["id"]

    response = await client.post(f"{BASE}/{profile_id}/complete")

    assert response.status_code == 400
    assert "valid voice samples are required" in response.json()["message"]
