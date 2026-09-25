#!/usr/bin/env python3
"""start_dev.py — one-command local development launcher for VoiceShift.

Starts (or reuses, if already healthy) the three services the desktop app
actually depends on:

    FastAPI backend        http://127.0.0.1:8000   (REST — profiles, samples, health)
    resident AI engine     ws://127.0.0.1:8765      (localhost WebSocket — live PCM)
    Electron desktop       `npm run dev` in desktop/

Every command below is the project's real, existing command (Makefile's
`backend` target, ai-worker's documented `serve` entrypoint, desktop's own
package.json `dev` script) — nothing invented. See docs/development.md for
the full explanation and docs/phase*-*.md for why each piece exists.

Usage:
    python scripts/start_dev.py
    (or: make dev)

Ctrl+C stops everything this script started. Services that were already
running before this script started are detected via a REAL health/protocol
check (never just "is the port open") and are left completely alone, both
at startup (reused, not duplicated) and at shutdown (never terminated).

This script depends on nothing beyond the Python 3.9+ standard library —
it orchestrates subprocesses, it doesn't need fastapi/uvicorn/websockets
importable in whatever Python runs it. The AI engine's protocol handshake
specifically reuses ai-worker's own `websockets` dependency (via a small
subprocess call into ai-worker/.venv) rather than hand-rolling a second
WebSocket client implementation.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
AI_WORKER_DIR = REPO_ROOT / "ai-worker"
DESKTOP_DIR = REPO_ROOT / "desktop"

# Matches desktop/src/shared/serviceConfig.ts exactly — the two places that
# know these numbers, on purpose (Python here has no way to import a .ts
# module, so this is the one unavoidable literal duplication; everything
# else that needs these values imports one or the other).
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
ENGINE_HOST = "127.0.0.1"
ENGINE_PORT = 8765
ENGINE_NAME = "openvoice_onnx"
PROTOCOL_VERSION = 1

READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL_SECONDS = 0.5
SHUTDOWN_GRACE_SECONDS = 5.0


# ---------------------------------------------------------------------------
# Logging — every line prefixed so it's obvious which service produced it.
# ---------------------------------------------------------------------------
def log_launcher(message: str) -> None:
    print(f"[LAUNCHER] {message}", flush=True)


# ---------------------------------------------------------------------------
# Health checks — real checks, never a bare TCP port probe. Pure functions
# (return value only, no process/global state) so tests can call them
# directly or patch them at the module level.
# ---------------------------------------------------------------------------
def port_is_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def check_backend_health(url: str = BACKEND_URL, timeout: float = 2.0) -> dict | None:
    """GET /api/v1/health — the backend's own liveness endpoint. Returns
    the parsed JSON body on success, None on any failure (connection
    refused, timeout, non-200, malformed body) — never raises."""
    try:
        with urllib.request.urlopen(f"{url}/api/v1/health", timeout=timeout) as resp:  # noqa: S310
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def check_backend_readiness(url: str = BACKEND_URL, timeout: float = 2.0) -> dict | None:
    """GET /api/v1/health/ready — includes real database/redis/ai status
    (see backend/app/api/routes/health.py). Used only to decide whether to
    print infrastructure guidance, never to gate backend reuse itself."""
    try:
        with urllib.request.urlopen(f"{url}/api/v1/health/ready", timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _ai_worker_python(ai_worker_dir: Path) -> Path:
    return ai_worker_dir / ".venv" / "bin" / "python"


def check_engine_handshake(
    host: str = ENGINE_HOST,
    port: int = ENGINE_PORT,
    ai_worker_dir: Path = AI_WORKER_DIR,
    timeout: float = 3.0,
) -> bool:
    """The actual engine.hello -> engine.welcome round trip (see
    ai-worker/app/server/protocol.py / websocket_server.py) — never just a
    port check. Shells out to ai-worker's own venv, reusing the exact
    `websockets` dependency the resident engine itself already requires,
    rather than a second hand-rolled WebSocket client."""
    python = _ai_worker_python(ai_worker_dir)
    if not python.exists():
        return False
    snippet = f"""
import asyncio, json

async def main():
    import websockets
    try:
        async with websockets.connect("ws://{host}:{port}", open_timeout={timeout}) as ws:
            await ws.send(json.dumps({{"version": {PROTOCOL_VERSION}, "type": "engine.hello", "request_id": "start_dev"}}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), timeout={timeout}))
            if reply.get("type") == "engine.welcome" and reply.get("protocol_version") == {PROTOCOL_VERSION}:
                print("OK")
                return
    except Exception:
        pass
    print("FAIL")

asyncio.run(main())
"""
    try:
        result = subprocess.run(  # noqa: S603
            [str(python), "-c", snippet],
            capture_output=True,
            text=True,
            timeout=timeout + 3,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return result.stdout.strip() == "OK"


def send_engine_shutdown(
    host: str = ENGINE_HOST,
    port: int = ENGINE_PORT,
    ai_worker_dir: Path = AI_WORKER_DIR,
    timeout: float = 3.0,
) -> bool:
    """Best-effort graceful engine.shutdown (see protocol.py MSG_SHUTDOWN) —
    mirrors desktop/src/main/engineProcessManager.ts's EngineProcessManager.stop()
    exactly: ask nicely first, the caller falls back to SIGTERM/SIGKILL
    regardless of what this returns."""
    python = _ai_worker_python(ai_worker_dir)
    if not python.exists():
        return False
    snippet = f"""
import asyncio, json

async def main():
    import websockets
    try:
        async with websockets.connect("ws://{host}:{port}", open_timeout={timeout}) as ws:
            await ws.send(json.dumps({{"version": {PROTOCOL_VERSION}, "type": "engine.shutdown", "request_id": "start_dev-shutdown"}}))
            await asyncio.wait_for(ws.recv(), timeout={timeout})
            print("OK")
            return
    except Exception:
        pass
    print("FAIL")

asyncio.run(main())
"""
    try:
        result = subprocess.run(  # noqa: S603
            [str(python), "-c", snippet],
            capture_output=True,
            text=True,
            timeout=timeout + 3,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return result.stdout.strip() == "OK"


def wait_until(predicate: Callable[[], bool], timeout: float, poll_interval: float = POLL_INTERVAL_SECONDS) -> bool:
    """Polls `predicate` until it returns True or `timeout` seconds pass."""
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll_interval)


# ---------------------------------------------------------------------------
# Process supervision — tracks only processes THIS launcher spawned.
# ---------------------------------------------------------------------------
class ManagedProcess:
    """One subprocess this launcher owns: its own process group (so the
    whole tree — e.g. npm's child electron process — stops together, the
    same reason dev.sh uses `setsid`), a background reader thread that
    prefixes and prints every line (stdout+stderr merged, never hidden),
    and a rolling buffer of recent lines for "last useful error" reporting."""

    def __init__(
        self,
        name: str,
        cmd: list[str],
        cwd: Path,
        log_prefix: str,
        env: dict[str, str] | None = None,
    ) -> None:
        self.name = name
        self.log_prefix = log_prefix
        self._last_lines: collections.deque[str] = collections.deque(maxlen=30)
        self._lock = threading.Lock()

        full_env = os.environ.copy()
        if env:
            full_env.update(env)

        self.popen = subprocess.Popen(  # noqa: S603
            cmd,
            cwd=str(cwd),
            env=full_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        self._reader_thread = threading.Thread(target=self._read_output, daemon=True)
        self._reader_thread.start()

    def _read_output(self) -> None:
        stdout = self.popen.stdout
        if stdout is None:
            return
        for line in stdout:
            line = line.rstrip("\n")
            print(f"{self.log_prefix} {line}", flush=True)
            with self._lock:
                self._last_lines.append(line)

    def is_alive(self) -> bool:
        return self.popen.poll() is None

    def exit_code(self) -> int | None:
        return self.popen.poll()

    def last_lines(self, n: int = 10) -> list[str]:
        with self._lock:
            return list(self._last_lines)[-n:]

    def terminate(self, grace_seconds: float = SHUTDOWN_GRACE_SECONDS) -> None:
        if not self.is_alive():
            return
        try:
            os.killpg(os.getpgid(self.popen.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        deadline = time.monotonic() + grace_seconds
        while self.is_alive() and time.monotonic() < deadline:
            time.sleep(0.1)
        if self.is_alive():
            try:
                os.killpg(os.getpgid(self.popen.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        self._reader_thread.join(timeout=2)


class EnvironmentError_(Exception):
    """Raised by verify_environment() — caught only at the top level so
    tests can assert on it without the process actually exiting."""


class ServiceFailedError(Exception):
    """Raised when a required service never becomes healthy, or dies
    before becoming healthy — carries enough detail for main() to report
    and exit(1)."""

    def __init__(self, service: str, reason: str, last_lines: list[str] | None = None) -> None:
        super().__init__(f"{service}: {reason}")
        self.service = service
        self.reason = reason
        self.last_lines = last_lines or []


class PortConflictError(Exception):
    """A port VoiceShift needs is already held by something that does not
    speak the expected protocol. The launcher never kills unknown
    processes automatically — this always means "stop, tell the user, and
    let them decide."""

    def __init__(self, service: str, port: int) -> None:
        super().__init__(f"Port {port} is already in use by another process.")
        self.service = service
        self.port = port


# ---------------------------------------------------------------------------
# Launcher
# ---------------------------------------------------------------------------
class DevLauncher:
    def __init__(
        self,
        repo_root: Path = REPO_ROOT,
        ready_timeout: float = READY_TIMEOUT_SECONDS,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self.repo_root = repo_root
        self.backend_dir = repo_root / "backend"
        self.ai_worker_dir = repo_root / "ai-worker"
        self.desktop_dir = repo_root / "desktop"
        self.ready_timeout = ready_timeout
        self.poll_interval = poll_interval
        self.managed: dict[str, ManagedProcess] = {}
        self.reused: set[str] = set()
        self._shutting_down = False

    # -- Step 1: environment sanity -----------------------------------
    def verify_environment(self) -> None:
        backend_python = self.backend_dir / ".venv" / "bin" / "python"
        if not backend_python.exists():
            raise EnvironmentError_(
                "Backend Python environment not found.\n\n"
                "Run:\n"
                "  cd backend\n"
                "  python3.12 -m venv .venv\n"
                "  source .venv/bin/activate\n"
                "  pip install -e \".[dev]\""
            )
        check = subprocess.run(  # noqa: S603
            [str(backend_python), "-c", "import fastapi, uvicorn"], capture_output=True, timeout=10
        )
        if check.returncode != 0:
            raise EnvironmentError_(
                "Backend virtual environment exists but dependencies are not installed.\n\n"
                "Run:\n"
                "  cd backend && source .venv/bin/activate && pip install -e \".[dev]\""
            )

        ai_python = self.ai_worker_dir / ".venv" / "bin" / "python"
        if not ai_python.exists():
            raise EnvironmentError_(
                "ai-worker Python environment not found.\n\n"
                "See ai-worker/README.md \"Setup\" for the full install steps "
                "(Python 3.10, torch, `pip install -e \".[dev]\"`)."
            )
        check = subprocess.run(  # noqa: S603
            [str(ai_python), "-c", "import websockets"], capture_output=True, timeout=10
        )
        if check.returncode != 0:
            raise EnvironmentError_(
                "ai-worker virtual environment exists but dependencies are not installed.\n\n"
                "Run:\n"
                "  cd ai-worker && .venv/bin/pip install -e \".[dev]\""
            )

        if not (self.desktop_dir / "node_modules").exists():
            raise EnvironmentError_("Desktop dependencies not installed.\n\nRun:\n  cd desktop && npm install")

    # -- Step 2: backend -------------------------------------------------
    def ensure_backend(self) -> None:
        health = check_backend_health()
        if health is not None:
            log_launcher(f"Backend already healthy at {BACKEND_URL} — reusing.")
            self.reused.add("backend")
            self._warn_if_infra_missing()
            return

        if port_is_open(BACKEND_HOST, BACKEND_PORT):
            raise PortConflictError("backend", BACKEND_PORT)

        log_launcher("Starting backend...")
        python = self.backend_dir / ".venv" / "bin" / "python"
        proc = ManagedProcess(
            "backend",
            [str(python), "-m", "uvicorn", "app.main:app", "--reload", "--host", BACKEND_HOST, "--port", str(BACKEND_PORT)],
            cwd=self.backend_dir,
            log_prefix="[BACKEND]",
        )
        self.managed["backend"] = proc
        self._wait_for_service("backend", proc, lambda: check_backend_health() is not None)
        log_launcher(f"Backend ready at {BACKEND_URL}")
        self._warn_if_infra_missing()

    def _warn_if_infra_missing(self) -> None:
        readiness = check_backend_readiness()
        if readiness is None:
            return
        db_ok = readiness.get("database") == "ok"
        redis_ok = readiness.get("redis") == "ok"
        if db_ok and redis_ok:
            return

        log_launcher("Backend is up, but local infrastructure isn't fully ready:")
        if not db_ok:
            log_launcher("  - PostgreSQL not reachable.")
        if not redis_ok:
            log_launcher("  - Redis not reachable.")

        # Only ever the plain, non-privileged command — if the caller isn't
        # in the docker group this simply fails and we fall through to the
        # manual instructions. Never store or prompt for a password.
        if shutil.which("docker"):
            log_launcher("  Attempting: docker compose up -d postgres redis")
            try:
                result = subprocess.run(  # noqa: S603, S607
                    ["docker", "compose", "up", "-d", "postgres", "redis"],
                    cwd=self.repo_root,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            except (subprocess.SubprocessError, OSError):
                result = None
            if result is not None and result.returncode == 0:
                log_launcher("  Infrastructure started.")
                return

        log_launcher("  Start local infrastructure with:")
        log_launcher("    sudo docker-compose up -d postgres redis")

    # -- Step 3: AI engine -------------------------------------------------
    def ensure_engine(self) -> None:
        if check_engine_handshake(ai_worker_dir=self.ai_worker_dir):
            log_launcher(f"AI engine already healthy at ws://{ENGINE_HOST}:{ENGINE_PORT} — reusing.")
            self.reused.add("ai")
            return

        if port_is_open(ENGINE_HOST, ENGINE_PORT):
            raise PortConflictError("ai engine", ENGINE_PORT)

        log_launcher("Starting resident AI engine...")
        python = self.ai_worker_dir / ".venv" / "bin" / "python"
        proc = ManagedProcess(
            "ai",
            [
                str(python), "-m", "app.main", "--engine", ENGINE_NAME, "serve",
                "--host", ENGINE_HOST, "--port", str(ENGINE_PORT),
            ],
            cwd=self.ai_worker_dir,
            log_prefix="[AI]",
        )
        self.managed["ai"] = proc
        self._wait_for_service("ai", proc, lambda: check_engine_handshake(ai_worker_dir=self.ai_worker_dir))
        log_launcher(f"AI engine ready at ws://{ENGINE_HOST}:{ENGINE_PORT}")

    def _wait_for_service(self, name: str, proc: ManagedProcess, is_healthy: Callable[[], bool]) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while True:
            if not proc.is_alive():
                raise ServiceFailedError(name, f"exited unexpectedly (code={proc.exit_code()})", proc.last_lines())
            if is_healthy():
                return
            if time.monotonic() >= deadline:
                raise ServiceFailedError(name, f"did not become healthy within {self.ready_timeout:.0f}s", proc.last_lines())
            time.sleep(self.poll_interval)

    # -- Step 4: desktop ---------------------------------------------------
    def start_desktop(self) -> None:
        log_launcher("Starting desktop...")
        env = {
            # We already own (or verified) the resident engine above —
            # Electron's own EngineProcessManager must not ALSO try to
            # spawn a second one and collide on the port.
            "VOICESHIFT_ENGINE_MODE": "external",
            "VOICESHIFT_BACKEND_URL": BACKEND_URL,
            "VOICESHIFT_ENGINE_HOST": ENGINE_HOST,
            "VOICESHIFT_ENGINE_PORT": str(ENGINE_PORT),
        }
        proc = ManagedProcess("desktop", ["npm", "run", "dev"], cwd=self.desktop_dir, log_prefix="[DESKTOP]", env=env)
        self.managed["desktop"] = proc
        # electron-vite fails fast (missing deps, bad config) — give it a
        # moment to prove it didn't immediately die before declaring success.
        time.sleep(2.0)
        if not proc.is_alive():
            raise ServiceFailedError("desktop", f"exited unexpectedly (code={proc.exit_code()})", proc.last_lines())

    def print_ready_banner(self) -> None:
        print()
        print("VoiceShift Development Environment Ready")
        print()
        print(f"Backend:\n  {BACKEND_URL}")
        print()
        print(f"AI Engine:\n  ws://{ENGINE_HOST}:{ENGINE_PORT}")
        print()
        print("Desktop:\n  running")
        print()
        print("Press Ctrl+C to stop all services.")
        print(flush=True)

    # -- Supervision / shutdown --------------------------------------------
    def supervise(self, poll_interval: float = 1.0, iterations: int | None = None) -> None:
        """Watches launcher-owned processes; `iterations=None` loops
        forever (real use), a finite value lets tests observe one pass
        without an infinite loop."""
        count = 0
        while iterations is None or count < iterations:
            time.sleep(poll_interval)
            for name, proc in list(self.managed.items()):
                if not proc.is_alive():
                    log_launcher(f"Service '{name}' exited unexpectedly (code={proc.exit_code()}). Stopping the rest...")
                    for line in proc.last_lines():
                        log_launcher(f"  {line}")
                    self.shutdown()
                    return
            count += 1

    def shutdown(self) -> None:
        if self._shutting_down:
            return
        self._shutting_down = True
        if not self.managed:
            return
        log_launcher("Stopping services...")
        # Shutdown order: Electron, then AI engine (graceful engine.shutdown
        # first), then backend — the reverse of startup order.
        if "desktop" in self.managed:
            log_launcher("Stopping desktop...")
            self.managed["desktop"].terminate()
        if "ai" in self.managed:
            log_launcher("Stopping AI engine (graceful shutdown)...")
            send_engine_shutdown(ai_worker_dir=self.ai_worker_dir)
            self.managed["ai"].terminate()
        if "backend" in self.managed:
            log_launcher("Stopping backend...")
            self.managed["backend"].terminate()
        for name in sorted(self.reused):
            log_launcher(f"({name} was already running before this launcher started — left it running.)")
        log_launcher("All launcher-owned services stopped.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.parse_args(argv)

    launcher = DevLauncher()

    def handle_signal(signum: int, frame: object) -> None:
        print()
        launcher.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        launcher.verify_environment()
        launcher.ensure_backend()
        launcher.ensure_engine()
        launcher.start_desktop()
    except EnvironmentError_ as exc:
        log_launcher(str(exc))
        return 1
    except PortConflictError as exc:
        log_launcher(str(exc))
        log_launcher(f"VoiceShift did not start this process and will not stop it. Free port {exc.port} and retry.")
        launcher.shutdown()
        return 1
    except ServiceFailedError as exc:
        log_launcher(f"{exc.service} failed to start: {exc.reason}")
        if exc.last_lines:
            log_launcher("Last output:")
            for line in exc.last_lines:
                log_launcher(f"  {line}")
        launcher.shutdown()
        return 1

    launcher.print_ready_banner()
    launcher.supervise()
    return 0


if __name__ == "__main__":
    sys.exit(main())
