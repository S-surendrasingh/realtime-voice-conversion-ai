# Phase 3 — CPU Voice Conversion

**Update (Phase 3.2): `openvoice_onnx` is now the default engine**, not
Seed-VC — see `docs/phase3.2-openvoice-onnx.md` for why (Seed-VC's real
streaming RTF proved unreliable; OpenVoice ONNX measured 0.30–0.65 typical
RTF and never needed backpressure under sustained real-time load). This
document remains accurate as the historical record of the offline
conversion architecture and Seed-VC's integration — the offline
`/convert` endpoint, the subprocess design, the caching design, and the
"do we need a conversions table" reasoning all still apply unchanged
regardless of which engine is selected.

Person A enrollment (Phase 2) → AI target preparation → Person B offline
source audio → CPU conversion → Person A-like output. This document covers
what Phase 3 actually built, why it's shaped this way, and — most
importantly — the real, measured performance numbers for Seed-VC,
including where they fell short of real-time (the reason Phase 3.2 exists).

## Architecture

```
Frontend (Next.js)
      │  HTTP (multipart)
      ▼
FastAPI Backend  ── unchanged: enrollment, consent, StorageService ──
      │
      │  POST /api/v1/voices/{id}/convert
      ▼
app/services/conversion.py
      │  reads valid samples via StorageService (local or S3 — unchanged)
      │  materializes them + the uploaded Person B clip to a temp dir
      ▼
app/services/ai_worker_client.py
      │  subprocess: <ai-worker>/.venv/bin/python -m app.main convert ...
      ▼
ai-worker/ (separate Python 3.10 runtime — see "Why a separate runtime")
      └── VoiceConversionEngine (PassthroughVoiceEngine | SeedVCVoiceEngine)
```

No GPU worker, no Redis job queue. This replaces the GPU/CUDA architecture
previously described in `README.md`/`docs/architecture.md` (now updated) —
see "README/Documentation Mismatches" in the Phase 2 audit for the prior
state.

## Why a separate Python runtime for ai-worker

The backend runs Python 3.12; Seed-VC's own tooling suggests Python 3.10.
Rather than force one interpreter to satisfy both, `ai-worker/` gets its
own venv (`ai-worker/.venv`, Python 3.10.14 via pyenv) with its own
`pyproject.toml`. This also keeps heavy ML dependencies (torch,
transformers, ~2GB+ of packages/weights) completely out of the backend's
environment, and keeps `ai-worker`'s GPL-3.0-licensed vendored code
(`vendor/seed-vc/`, see `docs/model-selection.md`) at arm's length from the
backend/frontend's own licensing.

## Why a subprocess, not a resident service

`VoiceConversionEngine` supports a `create_stream()`/`StreamSession` API
specifically so a *future* resident process (Phase 4, consumed by
Electron) can keep a model loaded across many calls. Phase 3 does not build
that resident service yet — the backend invokes `ai-worker`'s CLI fresh
per request. This means every conversion pays full model-load cost
(~7-9s, see benchmarks below) on top of inference time.

This is a deliberate, documented simplification, not an oversight: Phase
3's own priority order was **correctness first** ("Do not optimize before
measuring" — CPU Optimization guidance), and the diagnostic Test Conversion
UI this feeds is explicitly not a live/real-time surface. Promoting
`ai-worker` to a resident local HTTP or socket service (with the model
loaded once, `WARMING_UP`→`READY` tracked via the existing `EngineState`
lifecycle) is the natural next step once/if request latency from repeated
model loads becomes the bottleneck worth spending effort on — the engine
interface was designed so that change wouldn't require touching
`VoiceConversionEngine` implementations at all, only how `ai_worker_client`
invokes them.

## Do we need a conversions table?

**No.** A conversion is treated as an ephemeral diagnostic result:

- Its audio is stored via the existing `StorageService` at
  `voice-profiles/{profile_id}/derived/conversions/{conversion_id}.wav` —
  scoped under the profile that already has an ownership-checked route
  convention (`_get_owned_profile_or_404`), so retrieval
  (`GET /voices/{id}/conversions/{conversion_id}/audio`) needs no new auth
  path or table.
- The prepared-voice cache (see below) uses two deterministically-named
  keys per (profile, engine) — no table needed to look them up either.

The one thing a table *would* buy is being able to enumerate/list past
conversions or their exact ids without the client remembering them, and
clean up individual conversion audio files by id on profile deletion. This
phase's diagnostic UI doesn't need history browsing (each test-conversion
result is used immediately, not revisited), so that complexity was left
out — see "Known Limitations" for the resulting profile-delete gap.

## Target-voice preparation & caching

```
Voice Profile ID
      │
Backend retrieves VALID (non-deleted) sample rows from Postgres
      │
StorageService reads each sample's actual bytes (local disk or S3 — the
      AI layer never knows or cares which)
      │
Cache check: sha256(profile_id | engine | sorted(valid sample ids))
      │
   HIT  → download cached artifact from storage, skip ai-worker prepare
   MISS → write sample bytes to a temp dir, invoke `ai-worker ... prepare`,
          upload the resulting artifact + cache-key metadata back to
          storage at voice-profiles/{id}/derived/{engine}/{target.pt,metadata.json}
```

The cache key is keyed on the **set of valid sample ids**, not their
content bytes — a sample row is immutable once created (re-uploading
creates a new row/id; nothing edits one in place), so the id set is a
correct and much cheaper proxy than re-hashing audio bytes on every
request. Deleting or adding a valid sample changes the key, so the next
conversion naturally re-prepares rather than using a stale target voice.

Deleting a voice profile also deletes this cache (both keys, deterministic
names) — see `voice_profiles.delete_profile` /
`conversion.derived_cache_keys`.

## Offline conversion — Phase 3 Step 1

Verified with the example clips bundled in `vendor/seed-vc/examples/`
(`source_s1.wav` as a stand-in Person B clip, `s1p1.wav` as a stand-in
Person A reference — see "Existing Data Verification" for why these were
used instead of the real enrolled "surendra 1" samples).

| Diffusion steps | Model load | Reference prep | Conversion time | RTF | Peak RAM |
|---|---|---|---|---|---|
| 30 (upstream default) | 7.6s | 13.8s | 48.5s | **3.887** | 2218 MB |
| 10 | 8.3s | 2.6s | 23.0s | **1.843** | 2234 MB |
| 4 | 8.7s | 2.1s | 11.0s | **0.881** | 2174 MB |

(Source: 12.48s clip. Reference: 14.60s clip, 1 sample. System: 8-core
11th Gen Intel i5-11300H, 15.4GB RAM, Linux.)

Output was validated (`audio/postprocessing.py::validate_output`): no
NaN/Inf, in-range amplitude, non-silent, correct sample rate, playable —
confirmed for every run above. **No human listening evaluation was
performed** in this sandbox (no audio output device) — see "Known
Limitations".

**30 diffusion steps (upstream's own default) is kept as this project's
default** — it is the best-quality setting actually shipped, matching
upstream's own choice. Reduced-step configurations are documented here as
measured, available options (via `AI_SEED_VC_DIFFUSION_STEPS`), not
silently substituted, since fewer steps is a real quality/speed tradeoff
that was not perceptually evaluated.

## Chunked conversion — Phase 3 Step 5

`audio/chunking.py::convert_chunked` splits the source into overlapping
chunks, runs each independently through the full
semantic→diffusion→vocoder pipeline via `process_chunk()`, and stitches the
outputs with an equal-power crossfade (`audio/continuity.py`). Tested at 4
diffusion steps (the fastest offline-viable setting) across all 5 requested
chunk sizes:

| Chunk size | Avg latency | P95 latency | RTF | Gate <1.0 | Gate <0.70 |
|---|---|---|---|---|---|
| 100ms | 3246.9ms | 4846.1ms | 32.53 | FAIL | FAIL |
| 200ms | 3982.6ms | 5800.9ms | 20.11 | FAIL | FAIL |
| 300ms | 4407.0ms | 6040.4ms | 14.83 | FAIL | FAIL |
| 500ms | 4257.3ms | 5886.1ms | 8.53 | FAIL | FAIL |
| 1000ms | 5084.0ms | 6273.7ms | 5.30 | FAIL | FAIL |

**This is a real, important, honestly-reported negative result.**
Independent per-chunk conversion is dramatically worse than whole-file
conversion (RTF 5–32 vs. 0.88–3.9 offline) at every tested size, and gets
*worse* as chunks get smaller, not better. The reason: each chunk pays the
model's fixed per-call cost (semantic feature extraction, mel-spectrogram,
diffusion sampling setup) in full, and that fixed cost does not amortize
over a shorter chunk of audio — chunking does not currently reduce
per-chunk latency because there's no cross-chunk reuse of any of that
setup work. Continuity itself (the crossfade) worked correctly — waveforms
stitched without doing anything obviously wrong — but latency, not
continuity, is the blocker here.

This means the naive "chunk the file, run each chunk through the same
whole-pipeline call" approach implemented for Step 5 is **not a viable
path to real-time streaming** with this model as integrated. A real
low-latency streaming design would need to keep model state resident
across chunks and reuse expensive setup work (this is exactly the gap the
`create_stream()`/`StreamSession` API is a placeholder for) rather than
re-running the independent pipeline per chunk — that redesign is real,
nontrivial engine work, explicitly out of scope for Phase 3, and is the
most concrete, evidence-backed recommendation for whatever comes before a
live-microphone Phase 4.

## Streaming-readiness (internal API only)

`VoiceConversionEngine.create_stream(prepared_voice_path) -> StreamSession`
exists and is exercised by `SeedVCVoiceEngine`'s own implementation
(crossfades consecutive `process_chunk()` outputs, holding state — the
previous output's tail — entirely inside the session object). It is a
plain Python API, never imported by FastAPI, the frontend, or the storage
layer. Per Phase 3's scope, nothing calls it over a network transport —
that's Phase 4's job once a resident engine process exists to host it.

## CPU / thread configuration

Not benchmarked across explicit thread-count settings (1/2/4/6/8) in this
phase — `AI_TORCH_NUM_THREADS` exists as a configuration point
(`app/core/config.py`), and PyTorch's own default on this 8-core machine is
confirmed to be **4 threads** (`torch.get_num_threads()`), matching the
~400% CPU utilization observed during the offline benchmarks above.
Sweeping it was not prioritized given the chunked-conversion result already
shows the dominant cost is fixed per-call model overhead, not thread
scheduling — see "Known Limitations."

## Error handling

`app/core/errors.py` (ai-worker) defines the full requested code set:
`AI_MODEL_NOT_FOUND`, `AI_MODEL_LOAD_FAILED`, `AI_MODEL_DOWNLOAD_FAILED`,
`TARGET_VOICE_NOT_READY`, `TARGET_VOICE_PREPARATION_FAILED`,
`SOURCE_AUDIO_INVALID`, `CONVERSION_FAILED`, `INVALID_MODEL_OUTPUT`,
`INFERENCE_TOO_SLOW` (defined, not currently raised — no timeout-based
abort is implemented inside the engine itself; the backend's own subprocess
timeout, `AI_CONVERSION_TIMEOUT_SECONDS`, is the actual current backstop),
`CACHE_INVALID` (defined for future use — the current cache design
invalidates by key mismatch rather than raising this explicitly). The
backend never returns a raw stack trace: `AIConversionError` (HTTP 502,
not 400 — a model/worker failure isn't the caller's fault) carries only a
safe message; full detail is logged server-side
(`app/services/conversion.py`, `ai_worker_client.py`).

## Existing Data Verification

The Phase 2 audit's "empty storage directory" finding was a **false
alarm**, resolved during this phase: `docker-compose.yml` mounts backend
storage as a **named Docker volume** (`backend_storage:/app/storage`), not
a bind mount — so `backend/storage/` on the host was never where sample
bytes would appear, regardless of whether enrollment had run. Querying the
**live** running stack directly confirmed real, complete data:

- `GET /api/v1/voices` on the running backend (port 8000) returned the
  "surendra 1" profile, `status: READY_FOR_AI_PROCESSING`,
  `consent_confirmed: true`, 3 valid samples, 101.22s total duration.
- A direct `psql` query against the live Postgres container (its exposed
  host port, `localhost:5433`) confirmed 3 `voice_samples` rows with real
  `storage_key`s and file sizes (~3.1-3.3MB each, ~33s each).

**What could not be done**: extracting those actual sample *bytes* into
this sandbox to use as the real Person A reference for engine development.
The Docker daemon socket is not accessible from this environment (`docker
ps`/`exec` return permission denied), and the samples live inside a
Docker-managed named volume with no host-filesystem path — there is no
`docker cp` equivalent available here. The correct **production** access
path (backend reads via `StorageService`, exactly as implemented in
`app/services/conversion.py`) is real and tested end-to-end via the
backend integration test suite; it simply couldn't be exercised against
`surendra 1`'s specific bytes from outside the running container in this
session. For engine development and the benchmark numbers above, the
publicly-bundled example clips in `vendor/seed-vc/examples/` were used
instead, and that substitution is disclosed everywhere those numbers
appear.

## Known Limitations

- **Chunked/streaming RTF is far worse than offline RTF** (5.3–32.5 vs.
  0.88–3.9) — see "Chunked conversion" above. This is the single most
  important number in this document for judging live-conversion readiness.
- **The Dockerized backend cannot reach `ai-worker` today.**
  `docker-compose.yml` does not mount or build `ai-worker/`, and the
  backend container's image has no Python 3.10/torch environment. The
  `/convert` endpoint only works when the backend runs directly on the
  host (`make backend`), where `ai-worker/`'s sibling directory and its
  own venv are reachable by absolute path. This was a deliberate choice,
  not an oversight: wiring cross-container subprocess or HTTP access
  without any way to actually run `docker compose up` and verify it in
  this sandbox (no Docker daemon access — see the Phase 2 audit) would
  mean shipping unverified Docker plumbing. Fixing this is real,
  scoped follow-up work: either give `ai-worker` its own container
  exposing a small local HTTP endpoint the backend calls instead of a
  subprocess, or bake a CPU-torch venv into the backend image.
- **No human listening evaluation.** All "manual quality" observations in
  this document are limited to signal-level sanity checks (no NaN/Inf,
  non-silent, correct duration/sample rate) — no person listened to the
  converted audio in this sandbox (no audio output device available).
  Genuine perceptual quality (target similarity, naturalness, artifacts)
  is unverified.
- **Conversion output cleanup on profile deletion is partial.** The
  prepared-voice cache (deterministic keys) is deleted; individual past
  conversion audio files (random `conversion_id`-keyed) are not, since
  `StorageService` has no "list by prefix" capability to enumerate them —
  see "Do we need a conversions table?" above.
- **CPU thread-count was not swept.** See "CPU / thread configuration."
- **`INFERENCE_TOO_SLOW` is defined but never raised by the engine itself**
  — only the backend's subprocess timeout currently guards against a stuck
  conversion.
