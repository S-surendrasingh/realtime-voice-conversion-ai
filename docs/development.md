# Development Guide

## Prerequisites

- Python 3.12+ (backend)
- Python 3.10 (ai-worker, Phase 3 — optional, only needed for AI voice conversion; pyenv recommended)
- Node.js 20+
- PostgreSQL 14+ and Redis 6+ (locally, or via Docker Compose)
- Docker + Docker Compose (optional, for containerized local dev — note ai-worker
  is not part of the Docker stack yet, see `docs/phase3-ai-conversion.md`)

## First-time setup

```bash
cp .env.example .env   # fill in real values; never commit .env
make install
```

`make install` creates the backend virtualenv at `backend/.venv` and installs
Node dependencies for the frontend.

Create the database and apply migrations:

```bash
createdb voice_conversion
cd backend && source .venv/bin/activate
alembic upgrade head
```

## Day-to-day commands

| Command           | What it does                                              |
|--------------------|------------------------------------------------------------|
| `make backend`     | Run the FastAPI backend with auto-reload (port 8000)       |
| `make frontend`    | Run the Next.js dev server (port 3000)                     |
| `make dev`         | Run both concurrently                                       |
| `make test`        | Run the backend pytest suite                                |
| `make lint`        | Run Ruff (backend) and ESLint (frontend)                    |
| `make format`      | Auto-format backend code with Ruff                          |
| `make docker-up`   | Build and start postgres/redis/backend/frontend via Compose |
| `make docker-down` | Stop the Docker Compose stack                                |

## Backend

The backend uses a `src`-less `app/` package layout:

```text
backend/app/
├── api/            versioned routes (api/routes/*.py), router assembly, deps.py
├── core/           settings, logging, error handling
├── db/             SQLAlchemy engine/session + declarative base
├── models/         SQLAlchemy ORM models (User, VoiceProfile, VoiceSample)
├── schemas/        Pydantic request/response schemas
├── services/       business logic (health, storage, audio validation,
│                   voice profile/sample orchestration)
├── repositories/   thin DB-access functions, one module per model
├── websocket/      real-time endpoints (still empty — Phase 4+)
└── main.py         FastAPI app factory/entrypoint
```

Phase 3 additionally adds `services/conversion.py` (orchestrates AI target-voice
caching + calling the AI worker) and `services/ai_worker_client.py` (the
subprocess bridge to `ai-worker/`) — see `docs/phase3-ai-conversion.md`.

Configuration is environment-driven via `app/core/config.py`
(`pydantic-settings`), reading from `.env`. Never hardcode secrets or validation
limits — add new settings as fields on `Settings` instead.

### Database migrations

Alembic is configured (`backend/alembic/`) and manages `users`, `voice_profiles`,
`voice_samples`. To add a new table/column, add or change the model under
`app/models/`, make sure it's imported in `app/models/__init__.py`, then:

```bash
cd backend && source .venv/bin/activate
alembic revision --autogenerate -m "add <table>"
alembic upgrade head
```

Postgres enum types (used for `VoiceProfile.status` and `VoiceSample.status`) are
not dropped automatically when their table is dropped — if you hand-write a
migration that drops such a table, also drop the enum type in `downgrade()`
(`sa.Enum(name="...").drop(op.get_bind(), checkfirst=True)`), or `alembic
downgrade` followed by `alembic upgrade` will fail with "type already exists".

### Testing

```bash
cd backend && source .venv/bin/activate
pytest                 # all tests
pytest tests/unit      # unit tests only
pytest tests/integration
```

`backend/tests/conftest.py` forces `APP_ENV=test` and points `DATABASE_URL` at a
separate `voice_conversion_test` database (create it once with `createdb
voice_conversion_test`) so tests never touch the development database. It also
creates all tables via `Base.metadata.create_all` at the start of the session and
points `STORAGE_LOCAL_ROOT` at a temporary directory that's removed afterward, so
tests never touch your local `backend/storage/` folder either. Each test runs
inside a DB transaction that's rolled back afterward (via a SAVEPOINT that
survives `session.commit()` calls in application code), so tests never leak state
into each other.

- `tests/unit/` tests pure logic with dependencies mocked or swapped for fakes:
  config parsing, health-check aggregation, Redis abstraction, DB connectivity
  check, `AudioValidationService` (using synthetic WAV files built with the
  stdlib `wave` module — no test fixtures or extra dependencies needed),
  `LocalStorage` (path traversal, save/read/delete), `S3Storage` (boto3 client
  mocked).
- `tests/integration/` exercises real DB-backed behavior: model relationships and
  cascade deletes, the voice profile service's business rules (consent,
  completion thresholds), and the full HTTP API (via `httpx.AsyncClient` against
  an ASGI transport) including multipart file uploads and the end-to-end
  enrollment flow.

## AI worker (Phase 3)

A separate Python 3.10 package (`ai-worker/`) — see `docs/phase3-ai-conversion.md`
for the full architecture and `docs/model-selection.md` for the model and its
GPL-3.0 license. Day-to-day:

```bash
cd ai-worker
python3.10 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -e ".[dev]"
mkdir -p vendor && git clone --depth 1 https://github.com/Plachtaa/seed-vc.git vendor/seed-vc

.venv/bin/pytest                 # unit + integration, passthrough engine, no downloads
.venv/bin/pytest -m ai            # real Seed-VC smoke test — downloads real weights (~1.5-2GB)
.venv/bin/python -m app.main --engine passthrough health-check
```

The backend talks to this package as a subprocess (`app/services/ai_worker_client.py`),
resolved via `AI_WORKER_DIR`/`AI_WORKER_PYTHON` (default: the sibling `ai-worker/`
directory and its own venv — see the root `README.md`'s environment variable
table). This only works when the backend runs directly on the host; it is not
wired into `docker-compose.yml` yet — see `docs/phase3-ai-conversion.md` "Known
Limitations".

## Frontend

```text
frontend/
├── app/                    App Router pages
│   ├── page.tsx            Dashboard: list profiles + create-profile form
│   └── voices/[id]/page.tsx  Enrollment screen for one voice profile
├── components/             UI components (CreateVoiceProfileForm, AudioUploader,
│                           VoiceSampleList, VoiceProfileStatusBadge,
│                           TestConversionPanel, ...)
├── hooks/                  useVoiceProfiles, useVoiceProfile, useBackendHealth,
│                           useVoiceConversion
├── lib/                    API client (lib/api.ts)
├── types/                  Shared TypeScript types mirroring backend schemas
└── public/                 Static assets
```

`lib/api.ts` wraps every backend endpoint used by the UI and throws `ApiError` (with
the backend's error message) on non-2xx responses. `hooks/useVoiceProfile.ts` and
`hooks/useVoiceProfiles.ts` own the fetch-on-mount + refresh-after-mutation logic;
the initial fetch on mount is deliberately written as a self-contained,
cancellation-aware effect (not by calling the hook's exposed `refresh` from inside
`useEffect`) to satisfy React's `set-state-in-effect` lint rule — see the inline
comments if you need to add a similar hook.

### Recording vs. uploading

Phase 2 ships file upload only, not in-browser microphone recording. Browsers'
`MediaRecorder` API produces WebM/Opus (or similar compressed formats), which the
backend's `soundfile`-based validator can't decode without adding an ffmpeg-class
dependency — see [docs/architecture.md](architecture.md#audio-validation). The
`AudioUploader` component's `onUpload(file: File)` callback is the seam a future
recorder component would plug into. Phase 3's Test Conversion UI (uploading a
"Person B" clip) makes the same choice for the same reason — see
`docs/phase3-ai-conversion.md`.

### Frontend tests

Vitest + React Testing Library (`vitest.config.mts`, `vitest.setup.ts`):

```bash
cd frontend
npm test
```

`globals: false` in the Vitest config means Testing Library's automatic
per-test `cleanup()` doesn't self-register — `vitest.setup.ts` calls it
explicitly in an `afterEach`. If you add a new test file and see "multiple
elements found" errors that look like DOM from a previous test leaking in,
that hook not running is the first thing to check.

## Code quality

- Backend: Ruff handles both linting and formatting (`pyproject.toml` under
  `[tool.ruff]`). Run `make lint` / `make format`. Note
  `[tool.ruff.lint.flake8-bugbear].extend-immutable-calls` allowlists FastAPI's
  `Depends()`/`File()` idiom in argument defaults, which bugbear otherwise flags.
- Frontend: ESLint via `eslint-config-next` (includes the React Compiler-powered
  `react-hooks/*` rules). Run `npm run lint` inside `frontend/`, or `make lint`
  from the repo root. Type-check with `npx tsc --noEmit`. Run tests with `npm test`.
- ai-worker: Ruff (same conventions as the backend). Run `ruff check .` /
  `ruff format .` inside `ai-worker/`.

## Adding a new backend endpoint

1. Add/update the SQLAlchemy model under `app/models/` if needed, and generate a
   migration.
2. Define request/response schemas in `app/schemas/`.
3. Implement logic in `app/services/` (business rules) and `app/repositories/`
   (DB access).
4. Add a route module under `app/api/routes/` and register it in
   `app/api/router.py`.
5. Add unit tests for the service/validation logic and integration tests for the
   route (success and failure cases).
