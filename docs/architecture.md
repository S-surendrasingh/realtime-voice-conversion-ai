# Architecture

## Goal

Support real-time, continuous voice-to-voice conversion: Person B speaks live, the
system converts their speech into Person A's enrolled voice, preserving words,
language, and timing. This document describes the architecture the project is
building toward, what Phase 2 implements now, and why each piece is shaped this way.

## Why the API layer is separate from the AI worker

```text
FastAPI Backend  →  subprocess  →  ai-worker (CPU)
```

**This section previously described a GPU-worker-plus-Redis-queue design.**
That was never built, and as of Phase 3 it has been deliberately abandoned in
favor of something much simpler — CPU-only, no GPU, no cloud inference, per the
product's own constraints (see the repository root `README.md`). The reasoning
below is the *current*, real design; see `docs/phase3-ai-conversion.md` for the
full rationale and measured performance numbers.

The AI worker (`ai-worker/`) is a separate Python **3.10** package/runtime from
the backend's Python **3.12** — kept separate for dependency isolation (torch and
related ML packages never need to enter the backend's environment) and because
its vendored model code is GPL-3.0-licensed (see `docs/model-selection.md`),
which is cleaner to keep at a process boundary than imported directly into the
backend.

The backend invokes it as a **subprocess per request** (`app/services/ai_worker_client.py`
calls `ai-worker`'s CLI), not over a queue or a resident service — Redis is not
involved in AI conversion at all. This means every conversion currently pays a
full model-load cost on top of inference time; `VoiceConversionEngine` exposes a
`create_stream()` API specifically so a future resident process (Phase 4) can
avoid that without changing engine implementations. See
`docs/phase3-ai-conversion.md` "Why a subprocess, not a resident service" for why
this simpler design was chosen over building the queue/worker-fleet architecture
this section used to describe.

Redis's actual role remains exactly what it was before Phase 3: the
`/api/v1/health/ready` check, nothing more (see "Redis" below) — Phase 3
deliberately did not introduce a queue "because Redis exists," per the product
requirement to add complexity only when a measurement justifies it.

## Phase 3 architecture (implemented now)

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
                    ┌──────────┐ ┌──────────────┐     ┌─────────────────────┐
                    │PostgreSQL│ │ Voice Sample │────▶│      ai-worker       │
                    │(metadata)│ │   Storage    │     │ VoiceConversionEngine│
                    └──────────┘ └──────────────┘     │  CPU only, subprocess │
                                                        └─────────────────────┘
```

- **Frontend**: Next.js app. `/` lists existing voice profiles and lets the user
  create a new one (name, description, consent checkbox). `/voices/[id]` is the
  enrollment screen (upload samples, see validation results, delete samples, see
  running totals, complete enrollment) and, once `READY_FOR_AI_PROCESSING`, the
  Test Conversion panel (Phase 3 — see `docs/phase3-ai-conversion.md`).
- **Backend**: FastAPI app under `/api/v1/voices*` (see [API Endpoints](#api-endpoints)).
  Phase 2 modules: `models/` (SQLAlchemy ORM), `schemas/voice.py` (Pydantic request/
  response types), `services/audio_validation.py`, `services/storage.py`,
  `services/voice_profiles.py`, `services/voice_samples.py`, `repositories/`
  (thin DB-access functions). Phase 3 adds `services/conversion.py` (orchestrates
  caching + the AI worker call) and `services/ai_worker_client.py` (the subprocess
  bridge) — see `docs/phase3-ai-conversion.md`.
- **PostgreSQL**: stores `users`, `voice_profiles`, `voice_samples` — metadata and
  storage references only, never audio bytes (see [Database Schema](#database-schema)).
  No new tables were added for Phase 3 — see `docs/phase3-ai-conversion.md` "Do we
  need a conversions table?".
- **Voice Sample Storage**: pluggable storage backend, local filesystem by default
  (see [Storage Abstraction](#storage-abstraction)) — also now used to cache
  prepared AI target-voice artifacts and store converted audio, under a
  `derived/` sub-path per profile.
- **Redis**: still only used for the Phase 1 health/readiness check — Phase 3
  deliberately did not add a job queue (see "Why the API layer is separate from
  the AI worker" above).
- **ai-worker/**: real as of Phase 3 — a separate Python 3.10 package running the
  CPU voice-conversion engine, invoked by the backend as a subprocess. See
  `docs/phase3-ai-conversion.md`.
- **infrastructure/**: still empty, reserved for deployment/infra configuration.

## Voice Enrollment Flow

```text
Person A
   │
   ▼
Create voice profile (name, description, consent) ──► status: RECORDING
   │
   ▼
Upload voice sample(s) ──► AudioValidationService ──► VALID or INVALID
   │                                                    (stored either way,
   │                                                     with validation_error
   │                                                     set when INVALID)
   ▼
Delete unwanted/invalid samples
   │
   ▼
POST /voices/{id}/complete
   │   requires: consent_confirmed AND
   │             valid sample count >= MIN_VALID_VOICE_SAMPLES
   ▼
status: READY_FOR_AI_PROCESSING
   │
   ▼
POST /voices/{id}/convert (Phase 3 — see docs/phase3-ai-conversion.md)
   │   ai-worker prepares/caches a target-voice representation from the
   │   valid samples, then converts an uploaded "Person B" clip toward it
   ▼
Converted audio, retrievable via GET .../conversions/{conversion_id}/audio
```

`VoiceProfile.status` values: `DRAFT`, `RECORDING`, `PROCESSING`,
`READY_FOR_AI_PROCESSING`, `FAILED`, `ARCHIVED` (a Python `StrEnum`, stored as a
native Postgres enum — never a bare string). `PROCESSING` and `FAILED` are reserved
for the future AI phase and unused by Phase 2's own logic. A profile always starts
in `RECORDING`: consent is mandatory at creation time (see
[Consent Handling](#consent-handling)), so `DRAFT` exists in the enum for
completeness but the creation flow never produces it.

Deleting a sample doesn't remove its database row — it's marked `DELETED` and
excluded from listings and validity counts, while its underlying storage object is
actually removed. This keeps an audit trail (what was uploaded and why it failed
validation) without ever serving deleted audio again.

## Database Schema

```text
User
 │  id (uuid, pk), created_at, updated_at
 │
 └── VoiceProfile  (FK user_id, ON DELETE CASCADE)
       │  id, user_id, name, description, status,
       │  consent_confirmed, consent_confirmed_at,
       │  created_at, updated_at
       │
       └── VoiceSample  (FK voice_profile_id, ON DELETE CASCADE)
              id, voice_profile_id, storage_key, original_filename,
              mime_type, file_size, duration_seconds, sample_rate,
              channels, status, validation_error,
              created_at, updated_at
```

- One user can have multiple voice profiles; one profile can have multiple samples.
- Both foreign keys cascade on delete at the database level (`ondelete="CASCADE"`)
  *and* via SQLAlchemy's ORM-level `cascade="all, delete-orphan"`, so deleting a
  profile or user cleans up dependent rows either way.
- `voice_profiles.user_id` and `voice_samples.voice_profile_id` are indexed.
- `VoiceSample` never stores audio bytes — only `storage_key`, a reference into the
  storage abstraction below, plus metadata extracted during validation.
- Managed with Alembic (`backend/alembic/`); see
  [docs/development.md](development.md#database-migrations) for running migrations.

## Audio Validation

`AudioValidationService` (`app/services/audio_validation.py`) runs synchronously on
upload and returns a structured result:

```json
{
  "valid": true,
  "duration_seconds": 18.4,
  "sample_rate": 44100,
  "channels": 1,
  "errors": []
}
```

Checks performed, in order:

1. **Not empty** — zero-byte uploads are rejected immediately.
2. **File size** — rejected if larger than `MAX_SAMPLE_FILE_SIZE_MB` (default 25 MB).
3. **Supported extension** — only `.wav`, `.flac`, `.ogg` (see below).
4. **Decodable** — the file must actually parse as that audio format (via
   `soundfile`/libsndfile); corrupt or mislabeled files are rejected regardless of
   what MIME type the client claimed.
5. **Non-empty audio stream** — zero frames or zero sample rate is rejected.
6. **Duration** — must be between `MIN_SAMPLE_DURATION_SECONDS` (default 3s) and
   `MAX_SAMPLE_DURATION_SECONDS` (default 60s).
7. **Channels** — must be mono or stereo.

All limits are `Settings` fields (environment-driven), never hardcoded in the
validation logic.

**Why WAV/FLAC/OGG only, not MP3/M4A/WEBM:** decoding those formats needs an
external codec (ffmpeg or similar) — a much heavier dependency, with licensing
complexity for MP3 in particular. WAV is the format the product spec calls out as
primary; FLAC/OGG come for free from the same `soundfile`/libsndfile dependency
used for WAV. Browser-recorded audio (`MediaRecorder`) typically produces WebM/Opus,
which this validator can't decode — this is why Phase 2 ships a reliable file
upload flow rather than in-browser recording (see
[docs/development.md](development.md#recording-vs-uploading)).

## Storage Abstraction

```text
StorageService (ABC: save / read / delete / exists)
    │
    ├── LocalStorage   — writes under STORAGE_LOCAL_ROOT (default ./storage)
    │
    └── S3Storage      — boto3, any S3-compatible endpoint
                          (STORAGE_S3_BUCKET / _REGION / _ENDPOINT_URL)
```

Callers (`app/services/voice_samples.py`) only ever deal in storage *keys*, shaped
like:

```text
voice-profiles/{voice_profile_id}/samples/{sample_id}.{ext}
```

`{sample_id}` is a server-generated UUID and `{ext}` comes from the *detected*
audio format (from `soundfile`), never from the client-supplied filename — so
switching `STORAGE_BACKEND` from `local` to `s3` requires no code change in the
voice services, and there's no path-traversal surface: every key component the
service writes is one it generated itself. `LocalStorage` additionally rejects any
key containing `..` or an absolute path as defense in depth. The original filename
is still recorded as display-only metadata (sanitized to strip path separators and
non-filename characters) — it's never used to build a filesystem path or storage
key.

Voice sample files are never made publicly accessible: API responses expose sample
metadata (`VoiceSampleResponse`) but never the `storage_key` or a direct URL to the
underlying file.

## Consent Handling

`CreateVoiceProfileRequest.consent_confirmed` must be `true` — a Pydantic validator
rejects the request (422) otherwise, with a message equivalent to "I confirm I have
permission to create and use this voice profile." On acceptance, the service layer
stamps `consent_confirmed_at` with the current time and persists both fields
alongside the profile. There is no identity verification or KYC — this is
intentionally just an explicit, timestamped consent record, per the product
requirements for this phase. `complete_enrollment` re-checks `consent_confirmed` as
defense in depth, even though the current API can't produce a profile without it.

## API Endpoints

All under `/api/v1`. Requests are scoped to a fixed development user — see
[Authentication](#authentication) below.

| Method | Path                                   | Purpose                              |
|--------|-----------------------------------------|---------------------------------------|
| POST   | `/voices`                               | Create a voice profile (requires consent) |
| GET    | `/voices`                               | List the current user's voice profiles |
| GET    | `/voices/{id}`                          | Get one voice profile                 |
| PATCH  | `/voices/{id}`                          | Update name/description               |
| DELETE | `/voices/{id}`                          | Delete a profile and its samples      |
| POST   | `/voices/{id}/complete`                 | Complete enrollment → `READY_FOR_AI_PROCESSING` |
| POST   | `/voices/{id}/samples`                  | Upload a voice sample (multipart)     |
| GET    | `/voices/{id}/samples`                  | List a profile's (non-deleted) samples|
| GET    | `/voices/{id}/samples/{sample_id}`      | Get one sample                        |
| DELETE | `/voices/{id}/samples/{sample_id}`      | Delete a sample (removes storage object) |
| POST   | `/voices/{id}/convert`                  | Phase 3: convert a Person B clip toward this profile's AI voice (multipart, requires `READY_FOR_AI_PROCESSING`) |
| GET    | `/voices/{id}/conversions/{conversion_id}/audio` | Phase 3: retrieve converted audio |

See `docs/phase3-ai-conversion.md` for the conversion endpoints' full request/
response shape, caching behavior, and error codes — deliberately not duplicated
here to avoid the two documents drifting out of sync.

`VoiceProfileResponse` includes computed `sample_count`, `valid_sample_count`, and
`total_duration_seconds` (summed over valid samples only) so the frontend doesn't
need to re-derive them from the sample list. Internal database models are never
returned directly — every response is a dedicated Pydantic schema
(`app/schemas/voice.py`).

Business-rule violations (missing consent, insufficient valid samples, completing
an archived profile) raise a `DomainError` subclass and are translated to HTTP 400
by a shared exception handler (`app/core/security.py`); not-found resources return
404 via `HTTPException` directly in the route.

## Authentication

Phase 2 still has no login/signup/JWT — see the product requirement to defer
authentication. Every request is attributed to a single fixed "development user"
(`app/api/deps.py::get_current_user`), created lazily on first use. Voice profile
and sample services only ever take a `user_id`/ownership check as a parameter, so a
future phase can replace `get_current_user`'s internals with real
auth-derived user extraction without touching `services/voice_profiles.py`,
`services/voice_samples.py`, or any route signatures.

## What later phases add (not built in Phase 3)

- `api/routes/`: `auth`, `sessions`. (`conversion` — offline, file-based — is now
  built; a real-time/streaming variant is not.)
- `websocket/`: real-time audio streaming between frontend and backend.
- A resident `ai-worker` process (Phase 3 invokes it as a subprocess per request
  — see `docs/phase3-ai-conversion.md` "Why a subprocess, not a resident service").
- Electron desktop app, live microphone capture, virtual microphone output,
  Meet/Teams/Slack integration (Phase 4 — see the root `README.md`).
- `models/`: `sessions`, `usage_logs` (a `conversions` table was deliberately not
  added in Phase 3 — see `docs/phase3-ai-conversion.md` "Do we need a conversions
  table?").
- Authentication and authorization.
- In-browser microphone recording for Person B test input (currently: file upload
  only — see [docs/development.md](development.md#recording-vs-uploading); the
  same reasoning applies to Phase 3's Test Conversion UI).
