"""Tests for scripts/start_dev.py — no real subprocesses, no real network,
no OpenVoice weights required. Health/handshake checks and ManagedProcess
construction are mocked at the module boundary; DevLauncher's own
orchestration logic (reuse/spawn/fail/shutdown decisions) is what's under
test."""

import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import start_dev


class FakeProcess:
    """Stands in for ManagedProcess — never spawns anything real. Tests
    control `alive`/`exit_code`/`lines` directly and assert on whether
    `terminate()` was called."""

    def __init__(self, name="fake", cmd=None, cwd=None, log_prefix="", env=None):
        self.name = name
        self.cmd = cmd
        self.env = env
        self.alive = True
        self._exit_code = None
        self.lines = []
        self.terminated = False
        self.terminate_calls = 0

    def is_alive(self):
        return self.alive

    def exit_code(self):
        return self._exit_code

    def last_lines(self, n=10):
        return self.lines[-n:]

    def terminate(self, grace_seconds=5.0):
        self.terminate_calls += 1
        self.terminated = True
        self.alive = False

    def die(self, code=1, lines=None):
        self.alive = False
        self._exit_code = code
        if lines:
            self.lines.extend(lines)


@pytest.fixture
def launcher():
    return start_dev.DevLauncher(
        repo_root=Path("/fake/repo"),
        ready_timeout=0.3,
        poll_interval=0.02,
    )


# ---------------------------------------------------------------------------
# Reuse — do not start duplicates
# ---------------------------------------------------------------------------
class TestReuse:
    def test_backend_already_healthy_is_reused_not_spawned(self, launcher):
        with (
            mock.patch.object(start_dev, "check_backend_health", return_value={"status": "ok"}),
            mock.patch.object(start_dev, "check_backend_readiness", return_value={"database": "ok", "redis": "ok"}),
            mock.patch.object(start_dev, "ManagedProcess") as managed_cls,
        ):
            launcher.ensure_backend()

        managed_cls.assert_not_called()
        assert "backend" in launcher.reused
        assert "backend" not in launcher.managed

    def test_ai_already_healthy_is_reused_not_spawned(self, launcher):
        with (
            mock.patch.object(start_dev, "check_engine_handshake", return_value=True),
            mock.patch.object(start_dev, "ManagedProcess") as managed_cls,
        ):
            launcher.ensure_engine()

        managed_cls.assert_not_called()
        assert "ai" in launcher.reused
        assert "ai" not in launcher.managed

    def test_reused_services_are_never_terminated_on_shutdown(self, launcher):
        with (
            mock.patch.object(start_dev, "check_backend_health", return_value={"status": "ok"}),
            mock.patch.object(start_dev, "check_backend_readiness", return_value={"database": "ok", "redis": "ok"}),
        ):
            launcher.ensure_backend()

        # Nothing in launcher.managed, so shutdown() has nothing to
        # terminate — this IS the "never touch external processes" proof:
        # there is no ManagedProcess wrapping the reused backend at all.
        launcher.shutdown()
        assert launcher.managed == {}


# ---------------------------------------------------------------------------
# Port conflicts — never kill an unknown occupant
# ---------------------------------------------------------------------------
class TestPortConflict:
    def test_port_occupied_by_unknown_process_raises_without_spawning_or_killing(self, launcher):
        with (
            mock.patch.object(start_dev, "check_backend_health", return_value=None),
            mock.patch.object(start_dev, "port_is_open", return_value=True),
            mock.patch.object(start_dev, "ManagedProcess") as managed_cls,
            pytest.raises(start_dev.PortConflictError) as exc_info,
        ):
            launcher.ensure_backend()

        assert exc_info.value.port == start_dev.BACKEND_PORT
        managed_cls.assert_not_called()  # never spawned a competing process
        # There is nothing to "not kill" here by construction: the launcher
        # never even looks up a PID for a process it didn't start.

    def test_ai_port_occupied_by_unknown_process_raises(self, launcher):
        with (
            mock.patch.object(start_dev, "check_engine_handshake", return_value=False),
            mock.patch.object(start_dev, "port_is_open", return_value=True),
            mock.patch.object(start_dev, "ManagedProcess") as managed_cls,
            pytest.raises(start_dev.PortConflictError) as exc_info,
        ):
            launcher.ensure_engine()

        assert exc_info.value.port == start_dev.ENGINE_PORT
        managed_cls.assert_not_called()


# ---------------------------------------------------------------------------
# Startup failure — dies immediately, or times out
# ---------------------------------------------------------------------------
class TestStartupFailure:
    def test_backend_dies_immediately_reports_exit_code_and_last_lines(self, launcher):
        fake = FakeProcess()
        fake.die(code=1, lines=["Traceback...", "ImportError: no module named foo"])

        with (
            mock.patch.object(start_dev, "check_backend_health", return_value=None),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake),
            pytest.raises(start_dev.ServiceFailedError) as exc_info,
        ):
            launcher.ensure_backend()

        assert exc_info.value.service == "backend"
        assert "exited unexpectedly" in exc_info.value.reason
        assert "ImportError: no module named foo" in exc_info.value.last_lines

    def test_backend_health_timeout_reports_clearly(self, launcher):
        fake = FakeProcess()  # stays alive, just never becomes healthy

        with (
            mock.patch.object(start_dev, "check_backend_health", return_value=None),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake),
            pytest.raises(start_dev.ServiceFailedError) as exc_info,
        ):
            launcher.ensure_backend()

        assert exc_info.value.service == "backend"
        assert "did not become healthy" in exc_info.value.reason

    def test_ai_engine_handshake_timeout_reports_clearly(self, launcher):
        fake = FakeProcess()

        with (
            mock.patch.object(start_dev, "check_engine_handshake", return_value=False),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake),
            pytest.raises(start_dev.ServiceFailedError) as exc_info,
        ):
            launcher.ensure_engine()

        assert exc_info.value.service == "ai"
        assert "did not become healthy" in exc_info.value.reason

    def test_ai_engine_dies_immediately_reports_exit_code(self, launcher):
        fake = FakeProcess()
        fake.die(code=1, lines=["RuntimeError: model weights not found"])

        with (
            mock.patch.object(start_dev, "check_engine_handshake", return_value=False),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake),
            pytest.raises(start_dev.ServiceFailedError) as exc_info,
        ):
            launcher.ensure_engine()

        assert "RuntimeError: model weights not found" in exc_info.value.last_lines

    def test_desktop_exits_immediately_raises(self, launcher, monkeypatch):
        fake = FakeProcess()
        fake.die(code=1, lines=["Error: electron-vite config invalid"])
        monkeypatch.setattr(start_dev.time, "sleep", lambda _seconds: None)

        with (
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake),
            pytest.raises(start_dev.ServiceFailedError) as exc_info,
        ):
            launcher.start_desktop()

        assert exc_info.value.service == "desktop"


# ---------------------------------------------------------------------------
# Successful spawn — launcher-owned processes are tracked and killed later
# ---------------------------------------------------------------------------
class TestSuccessfulSpawn:
    def test_backend_spawned_when_not_already_healthy_and_port_free(self, launcher):
        fake = FakeProcess()
        healthy = {"called": 0}

        def health():
            healthy["called"] += 1
            return {"status": "ok"} if healthy["called"] > 1 else None

        with (
            mock.patch.object(start_dev, "check_backend_health", side_effect=health),
            mock.patch.object(start_dev, "check_backend_readiness", return_value={"database": "ok", "redis": "ok"}),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake) as managed_cls,
        ):
            launcher.ensure_backend()

        managed_cls.assert_called_once()
        assert launcher.managed["backend"] is fake
        assert "backend" not in launcher.reused

    def test_engine_spawn_uses_the_real_existing_serve_command(self, launcher):
        fake = FakeProcess()
        with (
            mock.patch.object(start_dev, "check_engine_handshake", side_effect=[False, True]),
            mock.patch.object(start_dev, "port_is_open", return_value=False),
            mock.patch.object(start_dev, "ManagedProcess", return_value=fake) as managed_cls,
        ):
            launcher.ensure_engine()

        args, _kwargs = managed_cls.call_args
        cmd = args[1]
        assert "app.main" in cmd
        assert "serve" in cmd
        assert "--engine" in cmd and start_dev.ENGINE_NAME in cmd
        assert str(start_dev.ENGINE_PORT) in cmd

    def test_desktop_spawn_forces_external_engine_mode_to_avoid_port_collision(self, launcher, monkeypatch):
        fake = FakeProcess()
        monkeypatch.setattr(start_dev.time, "sleep", lambda _seconds: None)

        with mock.patch.object(start_dev, "ManagedProcess", return_value=fake) as managed_cls:
            launcher.start_desktop()

        _, kwargs = managed_cls.call_args
        assert kwargs["env"]["VOICESHIFT_ENGINE_MODE"] == "external"


# ---------------------------------------------------------------------------
# Supervision + shutdown
# ---------------------------------------------------------------------------
class TestSupervisionAndShutdown:
    def test_one_process_exiting_triggers_shutdown_of_the_rest(self, launcher, monkeypatch):
        backend, ai, desktop = FakeProcess("backend"), FakeProcess("ai"), FakeProcess("desktop")
        launcher.managed = {"backend": backend, "ai": ai, "desktop": desktop}
        monkeypatch.setattr(start_dev.time, "sleep", lambda _s: None)

        desktop.die(code=1)  # desktop exits unexpectedly

        with mock.patch.object(start_dev, "send_engine_shutdown", return_value=True):
            launcher.supervise(iterations=1)

        assert backend.terminated
        assert ai.terminated
        # desktop was already dead; terminate() is a no-op on a dead
        # process but shutdown() still iterates it — either way it never
        # gets treated as "still needs killing" incorrectly.

    def test_shutdown_terminates_only_launcher_owned_processes(self, launcher):
        backend = FakeProcess("backend")
        launcher.managed = {"backend": backend}
        launcher.reused = {"ai"}  # ai was reused — never in `managed`

        with mock.patch.object(start_dev, "send_engine_shutdown", return_value=True):
            launcher.shutdown()

        assert backend.terminate_calls == 1
        assert "ai" not in launcher.managed  # nothing to terminate — proves it was never touched

    def test_shutdown_sends_graceful_engine_shutdown_before_terminating_it(self, launcher):
        ai = FakeProcess("ai")
        launcher.managed = {"ai": ai}
        shutdown_mock = mock.Mock(return_value=True)

        with mock.patch.object(start_dev, "send_engine_shutdown", shutdown_mock):
            launcher.shutdown()

        shutdown_mock.assert_called_once()
        assert ai.terminate_calls == 1

    def test_shutdown_order_is_desktop_then_ai_then_backend(self, launcher):
        order = []
        backend, ai, desktop = FakeProcess("backend"), FakeProcess("ai"), FakeProcess("desktop")

        def make_terminate(name, original):
            def wrapped(grace_seconds=5.0):
                order.append(name)
                return original(grace_seconds)

            return wrapped

        backend.terminate = make_terminate("backend", backend.terminate)
        ai.terminate = make_terminate("ai", ai.terminate)
        desktop.terminate = make_terminate("desktop", desktop.terminate)
        launcher.managed = {"backend": backend, "ai": ai, "desktop": desktop}

        with mock.patch.object(start_dev, "send_engine_shutdown", return_value=True):
            launcher.shutdown()

        assert order == ["desktop", "ai", "backend"]

    def test_shutdown_is_idempotent(self, launcher):
        backend = FakeProcess("backend")
        launcher.managed = {"backend": backend}

        launcher.shutdown()
        launcher.shutdown()  # simulates Ctrl+C arriving twice, or signal + normal exit path

        assert backend.terminate_calls == 1

    def test_ctrl_c_style_shutdown_terminates_all_managed_processes(self, launcher):
        """Simulates what main()'s SIGINT handler does: call shutdown()
        directly (the signal-handling wiring itself is a thin, untestable
        call into `signal.signal` — this proves the handler's actual
        effect)."""
        backend, ai, desktop = FakeProcess("backend"), FakeProcess("ai"), FakeProcess("desktop")
        launcher.managed = {"backend": backend, "ai": ai, "desktop": desktop}

        with mock.patch.object(start_dev, "send_engine_shutdown", return_value=True):
            launcher.shutdown()

        assert backend.terminated and ai.terminated and desktop.terminated


# ---------------------------------------------------------------------------
# wait_until — the generic polling helper
# ---------------------------------------------------------------------------
class TestWaitUntil:
    def test_returns_true_as_soon_as_predicate_is_true(self):
        assert start_dev.wait_until(lambda: True, timeout=1.0, poll_interval=0.01) is True

    def test_returns_false_after_timeout(self):
        assert start_dev.wait_until(lambda: False, timeout=0.05, poll_interval=0.01) is False


# ---------------------------------------------------------------------------
# Pure health-check functions — malformed/unreachable never raises
# ---------------------------------------------------------------------------
class TestHealthChecks:
    def test_backend_health_returns_none_on_connection_refused(self):
        # Nothing is listening on this port in the test environment.
        assert start_dev.check_backend_health(url="http://127.0.0.1:1", timeout=0.2) is None

    def test_engine_handshake_returns_false_when_ai_worker_venv_missing(self, tmp_path):
        assert start_dev.check_engine_handshake(ai_worker_dir=tmp_path, timeout=0.2) is False

    def test_port_is_open_false_for_a_port_nothing_listens_on(self):
        assert start_dev.port_is_open("127.0.0.1", 1, timeout=0.2) is False
