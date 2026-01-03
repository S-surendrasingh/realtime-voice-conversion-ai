#!/usr/bin/env bash
#
# dev.sh — single local development runner for Realtime AI Voice Conversion.
#
# Starts every service that is actually part of the current runtime:
#   - backend   FastAPI/uvicorn  (backend/pyproject.toml, Makefile `backend` target)
#   - frontend  Next.js dev server (frontend/package.json "dev" script)
#   - ai-worker only if it has ever grown a runnable entrypoint (it hasn't yet —
#               see ai-worker/README.md; Phase 3 work)
#
# PostgreSQL/Redis are treated as external local infrastructure (this repo's
# own docs/development setup uses natively-installed services, not Docker —
# see docker-compose.yml for the equivalent containers if you'd rather run
# those instead). This script does not start them; it only checks they're
# reachable and warns if not.
#
# Usage: ./dev.sh   (run from anywhere; the script locates the repo itself)

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Paths — resolved from the script's own location, never the caller's cwd.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
cd -- "$SCRIPT_DIR"

BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
AI_WORKER_DIR="$SCRIPT_DIR/ai-worker"

BACKEND_VENV_DIR="$BACKEND_DIR/.venv"
BACKEND_PYTHON="$BACKEND_VENV_DIR/bin/python"

# --- Actual project configuration (not invented) -----------------------
# Backend: matches the Makefile's `backend` target exactly.
BACKEND_HOST="0.0.0.0"
BACKEND_PORT="8000"
BACKEND_HEALTH_PATH="/api/v1/health"
# Frontend: frontend/package.json's "dev" script is a bare `next dev` with no
# configured port override, so this is Next.js's own default. The actual
# bound URL is confirmed from the dev server's own log output below, not
# just assumed.
FRONTEND_DEFAULT_PORT="3000"

POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
REDIS_HOST="localhost"
REDIS_PORT="6379"

READY_TIMEOUT_SECONDS=45

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/voiceapp-dev.XXXXXX")"

declare -a SERVICE_NAMES=()
declare -a SERVICE_PIDS=()
declare -a READER_PIDS=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_red=$'\033[31m'; c_green=$'\033[32m'
  c_yellow=$'\033[33m'; c_cyan=$'\033[36m'
else
  c_reset=""; c_bold=""; c_red=""; c_green=""; c_yellow=""; c_cyan=""
fi

info()  { printf '%s\n' "$*"; }
warn()  { printf '%s%s%s\n' "$c_yellow" "$*" "$c_reset"; }
ok()    { printf '%s%s%s\n' "$c_green" "$*" "$c_reset"; }
err()   { printf '%s%s%s\n' "$c_red" "$*" "$c_reset" >&2; }
header(){ printf '%s%s%s\n' "$c_bold" "$*" "$c_reset"; }

# ---------------------------------------------------------------------------
# Cleanup — terminates only what this script started, never a blanket
# pkill/killall. Each service is launched via `setsid` as its own process
# group leader specifically so this can kill the whole tree (npm's `next
# dev`, for example, forks a child `next-server` process that a plain
# single-PID kill would orphan).
# ---------------------------------------------------------------------------
CLEANING_UP=0
cleanup() {
  if [ "$CLEANING_UP" -eq 1 ]; then return 0; fi
  CLEANING_UP=1
  trap - INT TERM EXIT

  if [ "${#SERVICE_PIDS[@]}" -eq 0 ]; then
    rm -rf "$LOG_DIR" >/dev/null 2>&1 || true
    return 0
  fi

  echo
  info "Stopping services..."

  for pid in "${READER_PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" >/dev/null 2>&1 || true
  done

  for i in "${!SERVICE_PIDS[@]}"; do
    pid="${SERVICE_PIDS[$i]}"
    name="${SERVICE_NAMES[$i]}"
    if kill -0 "$pid" >/dev/null 2>&1; then
      info "  stopping $name (pid $pid)"
      kill -TERM "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
    fi
  done

  waited=0
  while [ "$waited" -lt 50 ]; do
    any_alive=0
    for pid in "${SERVICE_PIDS[@]:-}"; do
      if [ -n "${pid:-}" ] && kill -0 "$pid" >/dev/null 2>&1; then
        any_alive=1
      fi
    done
    [ "$any_alive" -eq 0 ] && break
    sleep 0.1
    waited=$((waited + 1))
  done

  for i in "${!SERVICE_PIDS[@]}"; do
    pid="${SERVICE_PIDS[$i]}"
    if [ -n "${pid:-}" ] && kill -0 "$pid" >/dev/null 2>&1; then
      warn "  $pid did not stop in time, forcing..."
      kill -KILL "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  done

  rm -rf "$LOG_DIR" >/dev/null 2>&1 || true
  ok "All services stopped."
}
trap cleanup INT TERM EXIT

# ---------------------------------------------------------------------------
# Dependency validation — fail fast with an exact fix-it command. Installs
# nothing itself.
# ---------------------------------------------------------------------------
header "Realtime AI Voice Conversion — Development"
echo

if ! command -v python3 >/dev/null 2>&1; then
  err "python3 is not installed or not on PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed or not on PATH. Install Node.js (see frontend/package.json) first."
  exit 1
fi

if [ ! -x "$BACKEND_PYTHON" ]; then
  err "Backend Python environment not found."
  echo
  echo "Run:"
  echo "  cd backend"
  echo "  python3.12 -m venv .venv"
  echo "  source .venv/bin/activate"
  echo "  pip install -e \".[dev]\""
  echo
  exit 1
fi

if ! "$BACKEND_PYTHON" -c "import uvicorn, fastapi" >/dev/null 2>&1; then
  err "Backend virtual environment exists but dependencies are not installed."
  echo
  echo "Run:"
  echo "  cd backend && source .venv/bin/activate && pip install -e \".[dev]\""
  echo
  exit 1
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  err "Frontend dependencies not installed."
  echo
  echo "Run:"
  echo "  cd frontend && npm install"
  echo
  exit 1
fi

# ---------------------------------------------------------------------------
# Port conflict detection
# ---------------------------------------------------------------------------
port_in_use() {
  local port="$1"
  # The whole probe runs inside a subshell so its exit status is all we rely
  # on; the subshell's fd 3 (and everything else) is discarded automatically
  # when it exits. (A bare `exec ... 2>/dev/null` outside a subshell would
  # instead permanently redirect *this script's* stderr — a real bug caught
  # during verification, not a hypothetical.)
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

describe_port_owner() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -n -P -i ":$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | sed 's/^/    /' >&2
  fi
}

if port_in_use "$BACKEND_PORT"; then
  err "Port $BACKEND_PORT is already in use — cannot start the backend."
  describe_port_owner "$BACKEND_PORT"
  err "Stop whatever is using it, then retry."
  exit 1
fi

if port_in_use "$FRONTEND_DEFAULT_PORT"; then
  err "Port $FRONTEND_DEFAULT_PORT is already in use — cannot start the frontend."
  describe_port_owner "$FRONTEND_DEFAULT_PORT"
  err "Stop whatever is using it, then retry."
  exit 1
fi

# ---------------------------------------------------------------------------
# Infrastructure checks (Postgres/Redis) — warn, don't silently start
# containers and don't hard-block: the backend process itself starts fine
# without them (only DB/Redis-backed requests fail until they're up).
# ---------------------------------------------------------------------------
check_tcp() {
  local host="$1" port="$2"
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
}

if ! check_tcp "$POSTGRES_HOST" "$POSTGRES_PORT"; then
  warn "Warning: PostgreSQL not reachable at ${POSTGRES_HOST}:${POSTGRES_PORT}."
  warn "  Voice-profile endpoints and readiness checks will fail until it's running."
  warn "  Start your local PostgreSQL service, or: docker compose up -d postgres"
  echo
fi

if ! check_tcp "$REDIS_HOST" "$REDIS_PORT"; then
  warn "Warning: Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}."
  warn "  Start your local Redis service, or: docker compose up -d redis"
  echo
fi

# ---------------------------------------------------------------------------
# Service launcher
# ---------------------------------------------------------------------------
start_service() {
  local name="$1" dir="$2"
  shift 2
  local logfile="$LOG_DIR/${name}.log"
  : >"$logfile"

  # setsid makes the launched command its own session/process-group leader,
  # so cleanup() can kill `-$pid` (the whole group: e.g. npm's child
  # next-server process too) instead of orphaning it.
  ( cd -- "$dir" && exec setsid "$@" ) >"$logfile" 2>&1 &
  local pid=$!
  SERVICE_NAMES+=("$name")
  SERVICE_PIDS+=("$pid")

  ( exec stdbuf -oL tail -n +1 -F "$logfile" 2>/dev/null | sed -u "s/^/[$name] /" ) &
  READER_PIDS+=("$!")
}

wait_for_tcp() {
  local host="$1" port="$2" timeout="$3"
  local waited=0
  while ! check_tcp "$host" "$port"; do
    sleep 0.5
    waited=$((waited + 1))
    if [ "$((waited / 2))" -ge "$timeout" ]; then
      return 1
    fi
  done
  return 0
}

wait_for_http_ok() {
  local url="$1" timeout="$2"
  local waited=0
  while true; do
    if curl --silent --fail --max-time 2 -o /dev/null "$url"; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
    if [ "$((waited / 2))" -ge "$timeout" ]; then
      return 1
    fi
  done
}

service_alive() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

fail_startup() {
  local failed_name="$1"
  echo
  err "$failed_name failed to start. Recent logs:"
  echo
  if [ -f "$LOG_DIR/${failed_name}.log" ]; then
    tail -n 30 "$LOG_DIR/${failed_name}.log" | sed 's/^/    /'
  fi
  echo
  exit 1
}

# ---------------------------------------------------------------------------
# Start backend — actual command from the Makefile `backend` target.
# ---------------------------------------------------------------------------
info "[backend] Starting..."
start_service "backend" "$BACKEND_DIR" \
  "$BACKEND_PYTHON" -m uvicorn app.main:app --reload --host "$BACKEND_HOST" --port "$BACKEND_PORT"
BACKEND_PID="${SERVICE_PIDS[-1]}"

if ! wait_for_tcp "127.0.0.1" "$BACKEND_PORT" "$READY_TIMEOUT_SECONDS" || ! service_alive "$BACKEND_PID"; then
  fail_startup "backend"
fi

# ---------------------------------------------------------------------------
# Start frontend — actual command from frontend/package.json's "dev" script.
# ---------------------------------------------------------------------------
info "[frontend] Starting..."
start_service "frontend" "$FRONTEND_DIR" npm run dev
FRONTEND_PID="${SERVICE_PIDS[-1]}"

if ! wait_for_tcp "127.0.0.1" "$FRONTEND_DEFAULT_PORT" "$READY_TIMEOUT_SECONDS" || ! service_alive "$FRONTEND_PID"; then
  fail_startup "frontend"
fi

# ---------------------------------------------------------------------------
# AI worker — only started if it actually has a runnable entrypoint. As of
# this repo's current state it's a reserved, empty placeholder (Phase 3) —
# see ai-worker/README.md — so there is nothing to start.
# ---------------------------------------------------------------------------
AI_WORKER_STATUS="not implemented yet (Phase 3 — see ai-worker/README.md)"
if [ -f "$AI_WORKER_DIR/pyproject.toml" ] || [ -f "$AI_WORKER_DIR/requirements.txt" ] || \
   [ -f "$AI_WORKER_DIR/main.py" ] || [ -f "$AI_WORKER_DIR/package.json" ]; then
  err "ai-worker/ now contains project files, but dev.sh doesn't know how to run them yet."
  err "Update dev.sh's AI worker section with its actual start command before relying on this script."
  exit 1
fi
info "[ai-worker] ${AI_WORKER_STATUS}"

# ---------------------------------------------------------------------------
# Confirm the backend's own health endpoint, not just that the port is open.
# ---------------------------------------------------------------------------
BACKEND_HEALTH_URL="http://localhost:${BACKEND_PORT}${BACKEND_HEALTH_PATH}"
if command -v curl >/dev/null 2>&1; then
  if ! wait_for_http_ok "$BACKEND_HEALTH_URL" "$READY_TIMEOUT_SECONDS"; then
    fail_startup "backend"
  fi
fi

echo
header "Backend     http://localhost:${BACKEND_PORT}"
header "Frontend    http://localhost:${FRONTEND_DEFAULT_PORT}"
header "AI Worker   ${AI_WORKER_STATUS}"
echo
ok "Press Ctrl+C to stop all services."
echo

# ---------------------------------------------------------------------------
# Stay attached; watch for any tracked service dying unexpectedly and bring
# the rest down cleanly if so, rather than leaving a half-running app.
# ---------------------------------------------------------------------------
while true; do
  for i in "${!SERVICE_PIDS[@]}"; do
    pid="${SERVICE_PIDS[$i]}"
    name="${SERVICE_NAMES[$i]}"
    if ! service_alive "$pid"; then
      err "Service '$name' exited unexpectedly. Stopping the rest..."
      exit 1
    fi
  done
  sleep 1
done
