# Phase 3.1 — Resident Real-Time CPU Voice Conversion

**Update (Phase 3.2): the resident engine architecture documented here
(EngineManager, WebSocket IPC, bounded backpressure, StreamSession) is
unchanged and now runs `openvoice_onnx` by default** — see
`docs/phase3.2-openvoice-onnx.md`. Every architectural section below
(IPC, Target Voice Cache, Backpressure, Model Lifecycle) applies to both
engines as-is; only the "Root Cause"/"Optimization Experiments" sections
are Seed-VC-specific history explaining why this phase's optimizations
(context reuse, reference-length capping) were necessary for Seed-VC and
are not applicable/needed for OpenVoice's different architecture.

Phase 3 proved offline CPU voice conversion works but that independent
per-chunk conversion (Phase 3's chunked benchmark) was far from real-time
(RTF 5.3–32.5). Phase 3.1's job was to find out *why*, fix everything
fixable without changing the model, and give an honest verdict on live
feasibility. This document is the source of truth for the resident engine
architecture and the real, measured results — see the final report
delivered alongside this phase for the full narrative.

## Architecture

```
Electron (Phase 4, not built yet)
      │  ws://127.0.0.1:PORT (local only)
      ▼
ai-worker: python -m app.main serve
      │
      ├── EngineManager — owns ONE resident VoiceConversionEngine instance
      │     • load()/warmup() run at most once per process lifetime
      │     • in-memory prepared-target-voice cache (see "Target Voice Cache")
      │
      └── per WebSocket connection: ConnectionHandler
            • at most one open stream per connection
            • ResidentStreamSession: bounded asyncio.Queue + backpressure
            • engine.create_stream() → context-aware _SeedVCStreamSession
```

The FastAPI backend's existing offline `/convert` endpoint is **completely
unchanged** — it still invokes `ai-worker`'s CLI as a subprocess per
request (see `docs/phase3-ai-conversion.md`). The resident engine is a
second, independent entry point (`python -m app.main serve`) aimed at
Phase 4; nothing in the backend depends on it.

## Root Cause (profiling, Phase 3.1 Step 2)

Real per-stage timing (`python -m app.main profile-chunk`, see
`app/audio/profiling.py`) on a 500ms chunk, default settings (14.6s
reference, 30 diffusion steps):

```
xlsr_feature_extraction     156.6 ms    0.5%
diffusion                 33485.3 ms   98.6%
vocoder                     315.4 ms    0.9%
```

At 4 diffusion steps (Phase 3's known-good offline setting), same 14.6s reference:

```
xlsr_feature_extraction     137.8 ms    3.2%
diffusion                  3962.9 ms   92.0%
vocoder                     197.0 ms    4.6%
total                      4305.7 ms
```

**Diffusion dominates — not XLS-R.** This alone contradicted the working
hypothesis carried over from Phase 3 (that the 300M-parameter XLS-R
encoder was the likely bottleneck). Digging further: diffusion cost did
**not** meaningfully depend on the chunk's own length — a 500ms chunk and
a 1000ms chunk cost roughly the same. What it depended on was the
**reference/prompt condition length**. Each diffusion step attends over
`cat_condition = [prompt_condition, chunk_cond]`, and `prompt_condition`
(built from Person A's reference audio) was ~14.6s long — far longer than
the chunk itself — so its cost dominates every step regardless of chunk
size. This explains Phase 3's counterintuitive finding that *smaller*
chunks had *worse* RTF: latency per call stayed roughly constant while the
denominator (chunk duration) shrank.

Confirmed by direct experiment (same 500ms chunk, 4 steps, varying only reference length):

| Reference length | diffusion (ms) | total (ms) |
|---|---|---|
| 14.6s (Phase 3 default) | 3962.9 | 4305.7 |
| 3s | 521.6 | 856.7 |
| 2s | 397.2 | 787.0 |
| 1s | 346.8 | 895.8 |

A ~7.6x reduction in diffusion cost from a 3s reference alone. This is the
single most important, non-obvious finding of Phase 3.1.

## What was tried (Steps 3–15)

| Lever | Result |
|---|---|
| Resident process (avoid ~8s reload per request) | Real, but doesn't touch per-chunk cost — Phase 3's own chunked benchmark already ran within one loaded process and was still slow. |
| Cached target voice (avoid re-preparation) | Real win for repeat streams of the same target; doesn't touch per-chunk cost. |
| No file I/O in the streaming path | Implemented — `process_chunk`/`StreamSession.process` operate on in-memory numpy arrays; the WebSocket protocol uses binary frames, never temp files. |
| Context reuse (Step 9) | Implemented (`_SeedVCStreamSession`, configurable `AI_STREAM_CONTEXT_SECONDS`) — prepends recent input audio for continuity. **Does not reduce cost** — it adds a small amount (more input = more to process); the benefit is quality/continuity, not speed. Confirmed by the same profiling data above (cost scales with reference length, not chunk/context length). |
| **Reference length cap for streaming** (new, discovered via profiling) | The real, effective lever — `AI_STREAM_REFERENCE_SECONDS` (default 3.0s), used only by the resident engine's `load_voice`, independent of the offline path's 25s cap. |
| Diffusion steps 30→10→4→2 | Roughly linear cost reduction, as in Phase 3. Tested down to 2 steps in Phase 3.1. |
| Thread count (1/2/6/8 vs. default 4) | **Inconclusive** — see "Known Limitations": measurement noise in this shared sandbox (run-to-run variance of ±30-50% observed) swamped any signal. No thread count showed a reliable, reproducible improvement over PyTorch's own default. |
| XLS-R replacement | Not attempted — profiling showed XLS-R is a minor contributor (3-22% of per-chunk cost, itself mostly fixed-cost, not the bottleneck), so replacing it would not address the actual root cause. |
| Vocoder (HiFTGenerator) optimization | Not modified — a real but secondary contributor (5-40% depending on config); no incremental/cached mode is exposed by the vendored implementation. |

## IPC Protocol

Local-only, binds `127.0.0.1` (never `0.0.0.0` — see `Settings.server_host`).
Transport: WebSocket (`websockets` package). Control messages are JSON text
frames; audio is **always** binary frames, never JSON/base64. Full
executable source of truth: `ai-worker/app/server/protocol.py`.

**Binary audio frame** (both directions): `[4 bytes sequence (uint32 LE)][4
bytes sample_rate (uint32 LE)][float32 LE PCM samples...]`.

**Control messages** (`{"version": 1, "type": "...", "request_id": "..."}`):

| Client → Server | Server → Client |
|---|---|
| `engine.hello` | `engine.welcome` (protocol_version) |
| `engine.health` | `engine.health_report` (EngineHealth fields) |
| `engine.load_voice` (voice_profile_id, reference_paths) | `engine.voice_loaded` (prepared_voice_id) |
| `engine.unload_voice` (voice_profile_id) | `engine.voice_unloaded` (unloaded: bool) |
| `stream.open` | `stream.opened` (session_id) |
| `stream.close` | `stream.closed` (+ final metrics: queue_depth, dropped_chunks, processed_chunks, avg_processing_latency_ms) |
| `engine.shutdown` | `engine.shutting_down`, then the server stops |
| — | `engine.error` (code, message) — on any failure, always correlatable via request_id where applicable |

One WebSocket connection hosts at most one open stream at a time. An
unexpected disconnect tears down only that connection's session — the
resident engine, its loaded model, and its target-voice cache are
unaffected (see `tests/integration/test_websocket_server.py::test_unexpected_disconnect_does_not_corrupt_engine_state`).

`engine.load_voice` currently takes local file paths (not inline bytes) —
the simplest option for a local-IPC design where the caller (Electron, or
a test) already has the reference files on disk. Revisit only if Phase 4
needs to pass in-memory bytes instead.

## Target Voice Cache

Keyed by `sha256(voice_profile_id | engine_name | model_version |
sorted(reference_file_hashes))` (`app/voices/cache.py`, shared with the
Phase 3 offline path's cache-key logic). A repeated `engine.load_voice`
for the same profile+references is a cache hit — no re-preparation
(verified in `tests/integration/test_websocket_server.py::test_second_connection_reuses_cached_target_voice`).
Changing a reference sample changes its hash and therefore the key,
naturally invalidating the cache. `engine.unload_voice` removes both the
in-memory entry and its on-disk artifact file.

## Backpressure

Each stream has a bounded `asyncio.Queue` (`AI_STREAM_MAX_QUEUE_DEPTH`,
default 4-6 depending on config). When full, a new audio frame is
**rejected** with an explicit `engine.error` (`code: BACKPRESSURE`) — never
silently dropped, and never allowed to accumulate unbounded latency. The
caller (Electron, in Phase 4) is responsible for deciding what to do
(pause capture, surface a warning, etc.) — this policy only guarantees the
resident engine itself stays honest about how far behind it is. Verified
under real, sustained overload (see "Streaming Stress Test" in the final
report): 4-9 of ~38 frames rejected per run once the queue filled, with
`processed_chunks`/`dropped_chunks` both reported in `stream.closed`.

## Model Lifecycle

`EngineState`: `NOT_LOADED → LOADING → WARMING_UP → READY ⇄ (CONVERTING |
STREAMING) → ERROR`, plus `SHUTTING_DOWN`. `EngineManager.ensure_loaded()`
is idempotent — `load()`/`warmup()` run at most once per process, proven
by a call-counter test (`tests/unit/test_engine_manager.py::test_ensure_loaded_loads_and_warms_up_exactly_once`)
rather than asserted from reading the code.
