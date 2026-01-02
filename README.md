# Realtime AI Voice Conversion

## 1. Project Overview

Realtime AI Voice Conversion will let an authorized "Person B" speak continuously into
a microphone while the system converts their live speech into the voice of an
authorized "Person A" in near real time — preserving Person B's words, language, and
timing while replacing the vocal identity with Person A's.

## 2. Current Phase

**Phase 3.2 — OpenVoice V2 + ONNX Runtime CPU Evaluation.** Phase 2 built Person A
voice enrollment (profile creation, consent, sample upload/validation/storage,
completion). Phase 3 added CPU AI conversion; Phase 3.1 added a resident
streaming engine + local WebSocket IPC but found Seed-VC's real streaming
performance unreliable (RTF 1.3–1.7 typical); Phase 3.2 evaluated and adopted
**OpenVoice V2 (MIT licensed, via ONNX Runtime)** as the new default engine —
real, measured streaming RTF 0.30–0.65, comfortably beating real-time with no
backpressure needed under sustained load. See
[docs/phase3.2-openvoice-onnx.md](docs/phase3.2-openvoice-onnx.md) for the full
comparison.

```text
Person A enrollment (Phase 2)
        ↓
AI target preparation (ai-worker, cached)
        ↓
Person B audio (offline upload, or a resident streaming session)
        ↓
CPU voice conversion — OpenVoice V2 / ONNX (default) or Seed-VC (no GPU, no CUDA, no cloud inference)
        ↓
Person A-like output, played back locally
```

**Phase 3 AI execution: CPU-only**, for both engines. See
[docs/phase3-ai-conversion.md](docs/phase3-ai-conversion.md) for the offline
architecture, [docs/phase3.1-resident-engine.md](docs/phase3.1-resident-engine.md)
for the resident streaming engine/IPC protocol,
[docs/phase3.2-openvoice-onnx.md](docs/phase3.2-openvoice-onnx.md) for the engine
comparison and why OpenVoice was selected, and
[docs/model-selection.md](docs/model-selection.md) for both models' licenses
(**OpenVoice V2: MIT — code and weights. Seed-VC: GPL-3.0** — read before
distributing anything).

Explicitly **not** implemented in Phase 3: a desktop app, real-time/live
microphone streaming, a virtual microphone, Meet/Teams/Slack integration, GPU
inference, cloud/paid AI APIs, and user authentication (a fixed development user
is still used — see [docs/architecture.md](docs/architecture.md#authentication)).
Those are Phase 4+.

## 3. Future Product Behavior

1. Person A enrolls by recording a handful of natural voice samples. The system
   learns the *characteristics* of Person A's voice rather than memorizing sentences.
   **This is what Phase 2 implements**, stopping at a validated, stored set of
   samples — no AI model is trained yet.
2. Person B speaks live into a microphone, saying anything — including sentences
   Person A never recorded.
3. The system streams Person B's audio through a real-time voice conversion model
   and outputs the same words, in Person A's voice, continuously for as long as
   Person B keeps speaking.
4. When Person B stops speaking, output stops. When they resume, conversion resumes.

The pipeline is voice-to-voice (`B audio → conversion model → A audio`), not a
speech-to-text-to-speech pipeline.

## 4. Tech Stack

| Layer      | Technology                                                        |
|------------|--------------------------------------------------------------------|
| Frontend   | Next.js (App Router), TypeScript, ESLint                          |
| Backend    | Python 3.12, FastAPI, Uvicorn, Pydantic Settings, SQLAlchemy, Alembic |
| Database   | PostgreSQL                                                          |
| Cache/Queue| Redis                                                               |
| Audio      | soundfile (WAV/FLAC/OGG decoding + validation)                     |
| Storage    | Pluggable: local filesystem (default) or S3-compatible (boto3)     |
| Testing    | pytest, pytest-asyncio, httpx (backend); Vitest, React Testing Library (frontend) |
| Tooling    | Ruff (lint + format), Docker Compose, Make                        |
| AI (default) | OpenVoice V2 via ONNX Runtime (**CPU only**, MIT licensed) — isolated in `ai-worker/` (Python 3.10) |
| AI (alternative) | Seed-VC (`seed-uvit-tat-xlsr-tiny`), PyTorch — **CPU only**, GPL-3.0, kept for comparison |

## 5. Architecture

Current architecture (Phase 3 — CPU only, no GPU worker):

```text
                    ┌─────────────────────┐
                    │      Frontend       │
                    │   Next.js + TS      │
                    └──────────┬──────────┘
                               │
                          HTTP (JSON + multipart)
                               │
                               ▼
                    ┌─────────────────────┐
                    │    FastAPI Backend  │
                    │  /api/v1/voices*    │
                    │  /api/v1/health*    │
                    └──────┬───────┬──────┘
                           │       │
                           ▼       ▼
                    ┌──────────┐ ┌──────────────┐
                    │PostgreSQL│ │ Voice Sample │
                    │(metadata)│ │   Storage    │
                    └──────────┘ └──────┬───────┘
                                         │ subprocess (see docs/phase3-ai-conversion.md)
                                         ▼
                                  ┌─────────────────────┐
                                  │      ai-worker       │
                                  │ VoiceConversionEngine│
                                  │  CPU only — no CUDA  │
                                  └─────────────────────┘
```

`ai-worker` is a separate Python 3.10 package/runtime with its own dependencies
(kept out of the backend's Python 3.12 environment) — see
[docs/phase3-ai-conversion.md](docs/phase3-ai-conversion.md) for why, and for the
real, measured performance numbers (offline conversion works; chunked/streaming
conversion currently does not hit real-time — reported honestly, not hidden).

Future (Phase 4, not built yet):

```text
Electron Desktop
      ↓
Physical Mic
      ↓
Phase 3 Voice Engine (promoted to a resident local process)
      ↓
Virtual Mic
      ↓
Meet / Teams / Slack
```

See [docs/architecture.md](docs/architecture.md) for the full rationale, the voice
enrollment data model, and the storage abstraction.

Monorepo layout:

```text
realtime-voice-conversion-ai/
├── frontend/          Next.js app (enrollment UI + Test Conversion UI)
├── backend/           FastAPI service (API, DB, storage, validation, tests)
├── ai-worker/         CPU voice conversion engine (Python 3.10, separate runtime)
├── infrastructure/    Reserved for deployment/infra configuration
├── docs/              Architecture and development docs
├── tests/             Reserved for cross-service/e2e tests
├── docker-compose.yml Local dev orchestration (frontend, backend, postgres, redis —
│                      ai-worker is NOT yet in Compose, see docs/phase3-ai-conversion.md)
├── Makefile           Common developer commands
└── .env.example       Environment variable template
```

## 6. Local Setup

Prerequisites: Python 3.12+, Node.js 20+, PostgreSQL, Redis (or Docker for all of
the above).

```bash
git clone <repo-url>
cd realtime-voice-conversion-ai
cp .env.example .env          # then fill in real values
make install
```

Create the database and run migrations (see [docs/development.md](docs/development.md)
for full detail):

```bash
createdb voice_conversion
cd backend && source .venv/bin/activate
alembic upgrade head
```

(Docker Compose now runs this automatically on every backend container start — see
section 10 — this manual step is only needed when running the backend directly.)

To also enable AI voice conversion (Phase 3, optional — enrollment works without
it), set up `ai-worker/` separately: see [ai-worker/README.md](ai-worker/README.md).

## 7. Environment Variables

Defined in `.env.example` (copy to `.env`, never commit `.env`):

| Variable                     | Purpose                                             |
|-------------------------------|------------------------------------------------------|
| `APP_ENV`                    | `development` / `test` / `production`                |
| `DATABASE_URL`                | SQLAlchemy PostgreSQL connection string               |
| `REDIS_URL`                   | Redis connection string                               |
| `SECRET_KEY`                  | Application secret (never hardcode in code)           |
| `CORS_ORIGINS`                | Comma-separated list of allowed frontend origins      |
| `STORAGE_BACKEND`             | `local` (default) or `s3`                             |
| `STORAGE_LOCAL_ROOT`          | Directory for voice sample files when using `local`   |
| `STORAGE_S3_BUCKET`           | Bucket name when using `s3`                           |
| `STORAGE_S3_REGION`           | AWS region when using `s3`                            |
| `STORAGE_S3_ENDPOINT_URL`     | Optional override for S3-compatible services (MinIO)  |
| `MIN_SAMPLE_DURATION_SECONDS` | Minimum accepted voice sample duration (default `3`)  |
| `MAX_SAMPLE_DURATION_SECONDS` | Maximum accepted voice sample duration (default `60`) |
| `MAX_SAMPLE_FILE_SIZE_MB`     | Maximum accepted upload size (default `25`)           |
| `MIN_VALID_VOICE_SAMPLES`     | Valid samples required to complete enrollment (`3`)   |
| `NEXT_PUBLIC_API_URL`         | Base URL the frontend uses to reach the backend       |
| `AI_ENGINE`                   | `seed_vc` (default) or `passthrough` (identity, for tests) |
| `AI_WORKER_DIR`               | Path to `ai-worker/` (defaults to the sibling directory) |
| `AI_WORKER_PYTHON`            | Path to `ai-worker`'s interpreter (defaults to `<AI_WORKER_DIR>/.venv/bin/python`) |
| `AI_CONVERSION_TIMEOUT_SECONDS` | Subprocess timeout for one conversion (default `600`) |

## 8. Running the Backend

```bash
make backend
# or manually:
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

The API is versioned under `/api/v1`:

- `GET /api/v1/health`, `/health/live`, `/health/ready` — health/readiness checks
- `POST/GET /api/v1/voices`, `GET/PATCH/DELETE /api/v1/voices/{id}` — voice profiles
- `POST /api/v1/voices/{id}/complete` — complete enrollment once enough valid
  samples exist
- `POST/GET /api/v1/voices/{id}/samples`, `GET/DELETE /api/v1/voices/{id}/samples/{sample_id}`
  — voice sample upload, listing, and deletion
- `POST /api/v1/voices/{id}/convert` — Phase 3: convert an uploaded "Person B" clip
  toward this profile's AI voice (requires `READY_FOR_AI_PROCESSING`)
- `GET /api/v1/voices/{id}/conversions/{conversion_id}/audio` — retrieve converted audio

See [docs/architecture.md](docs/architecture.md#api-endpoints) and
[docs/phase3-ai-conversion.md](docs/phase3-ai-conversion.md) for full request/response
detail.

## 9. Running the Frontend

```bash
make frontend
# or manually:
cd frontend
npm install
npm run dev
```

Visit `http://localhost:3000` to create a voice profile, upload voice samples,
complete enrollment, and — once ready — test AI voice conversion on the profile's
page. See [docs/architecture.md](docs/architecture.md#voice-enrollment-flow) and
[docs/phase3-ai-conversion.md](docs/phase3-ai-conversion.md) for the full flows.

## 10. Running with Docker

```bash
docker compose up --build
docker compose down
```

This starts `postgres`, `redis`, `backend` (http://localhost:8000), and `frontend`
(http://localhost:3000). Migrations now run automatically on backend startup (see
`backend/docker-entrypoint.sh`) — no manual `alembic upgrade head` needed for a
fresh stack. Uploaded voice sample files persist in the `backend_storage` Docker
volume.

**AI conversion (Phase 3) does not work through this Docker stack yet** —
`ai-worker/` isn't built into any image or mounted into the backend container. It
works when the backend runs directly on the host (`make backend`) with `ai-worker/`
set up as a sibling directory. See
[docs/phase3-ai-conversion.md](docs/phase3-ai-conversion.md) "Known Limitations".

## 11. Running Tests

```bash
make test
# or:
cd backend && source .venv/bin/activate && pytest       # backend
cd ai-worker && .venv/bin/pytest                          # ai-worker (passthrough engine, no downloads)
cd ai-worker && .venv/bin/pytest -m ai                     # real Seed-VC smoke test (downloads real weights)
cd frontend && npm test                                    # frontend (Vitest + React Testing Library)
```

Backend tests run against a dedicated `voice_conversion_test` PostgreSQL database
(see [docs/development.md](docs/development.md#testing)) and a temporary local
storage directory — they never touch the development database or `storage/`
folder. The backend's conversion tests invoke the real `ai-worker` CLI as a
subprocess with its `passthrough` engine — a real process boundary, not a mock,
but without downloading any model weights.

## 12. Code Quality Commands

```bash
make lint      # ruff check (backend) + eslint (frontend)
make format    # ruff format (backend)
```

Frontend type-checking: `cd frontend && npx tsc --noEmit`.

## Recommended Next Phase

Phase 3.2 found a CPU engine (OpenVoice V2 via ONNX Runtime) that reliably beats
real-time under sustained, real wall-clock-paced streaming (RTF 0.30–0.65,
0 backpressure rejections across a 62-second stress test) — see
[docs/phase3.2-openvoice-onnx.md](docs/phase3.2-openvoice-onnx.md) for the full
benchmark. **Human perceptual validation of output quality is still required**
before Phase 4 (Electron desktop app, live microphone, virtual microphone,
Meet/Teams/Slack) begins — no one has listened to the generated audio yet (see
that document's "Human Listening" section and the artifacts under
`ai-worker/benchmark_artifacts/phase3.2/`).
