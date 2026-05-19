import pytest

from app.server.engine_manager import EngineManager
from tests.fakes import FakeVoiceConversionEngine


@pytest.fixture
def manager(tmp_path, settings):
    engine = FakeVoiceConversionEngine()
    return EngineManager(engine, tmp_path / "targets", settings), engine


def test_ensure_loaded_loads_and_warms_up_exactly_once(manager):
    mgr, engine = manager
    mgr.ensure_loaded()
    mgr.ensure_loaded()
    mgr.ensure_loaded()
    assert engine.load_count == 1
    assert engine.warmup_count == 1


def test_load_voice_prepares_on_first_call(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    prepared_id, artifact_path = mgr.load_voice("profile-1", [ref])
    assert prepared_id
    assert artifact_path.exists()
    assert len(engine.prepare_calls) == 1


def test_load_voice_cache_hit_skips_repreparation(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    mgr.load_voice("profile-1", [ref])
    mgr.load_voice("profile-1", [ref])
    assert len(engine.prepare_calls) == 1  # second call was a cache hit


def test_load_voice_cache_invalidates_when_reference_changes(manager, make_wav):
    mgr, engine = manager
    ref_a = make_wav("ref_a.wav", seed=1)
    ref_b = make_wav("ref_b.wav", seed=2)
    mgr.load_voice("profile-1", [ref_a])
    mgr.load_voice("profile-1", [ref_b])
    assert len(engine.prepare_calls) == 2


def test_load_voice_different_profiles_are_independent(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    mgr.load_voice("profile-1", [ref])
    mgr.load_voice("profile-2", [ref])
    assert mgr.cached_target_count() == 2


def test_unload_voice_removes_cache_entry_and_artifact(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    _prepared_id, artifact_path = mgr.load_voice("profile-1", [ref])
    assert mgr.unload_voice("profile-1") is True
    assert not artifact_path.exists()
    assert mgr.cached_target_count() == 0


def test_unload_unknown_profile_returns_false(manager):
    mgr, _engine = manager
    assert mgr.unload_voice("never-loaded") is False


def test_reloading_after_unload_prepares_again(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    mgr.load_voice("profile-1", [ref])
    mgr.unload_voice("profile-1")
    mgr.load_voice("profile-1", [ref])
    assert len(engine.prepare_calls) == 2


def test_shutdown_unloads_engine_and_clears_cache(manager, make_wav):
    mgr, engine = manager
    ref = make_wav("ref.wav")
    mgr.load_voice("profile-1", [ref])
    mgr.shutdown()
    assert engine.unload_count == 1
    assert mgr.cached_target_count() == 0
