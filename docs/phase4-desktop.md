# Phase 4 — Electron Desktop Application

Phase 3.2 selected `openvoice_onnx` as the live CPU streaming engine (RTF
0.40-0.65 typical, see `docs/phase3.2-openvoice-onnx.md`) and confirmed via
manual listening that the converted voice is clear and reasonably close to
Person A, with a known "slightly robotic" quality limitation (unchanged,
not addressed in this phase — see "Known Limitations" in the Phase 4 final
report). Phase 4's job was to put a real physical microphone and a real
desktop UI in front of that existing, unmodified resident-engine pipeline.

This document is the architecture reference for `desktop/`. It does not
repeat the IPC protocol narrative — see `docs/phase3.1-resident-engine.md`
for that; this file only describes what Phase 4 built on top of it and the
one small, additive backend endpoint it required.

## What was reused vs. built

Reused as-is, unmodified: `ai-worker`'s resident engine process
(`python -m app.main --engine openvoice_onnx serve`), its WebSocket IPC
protocol (`ai-worker/app/server/protocol.py` — mirrored, not reimplemented,
in `desktop/src/shared/protocol.ts`, including a byte-for-byte golden-fixture
test against real Python-encoded frames), its backpressure/target-voice-cache
behavior, and the backend's voice-profile enrollment API.

Added: the entire `desktop/` Electron application, and one small backend
endpoint — see "Backend Change" below.

## Backend Change (the one addition outside `desktop/`)

`GET /api/v1/voices/{voice_profile_id}/samples/{sample_id}/audio` —
returns a reference sample's raw audio bytes. This did not exist before
Phase 4: the backend's own offline conversion path reads sample bytes
directly from its storage abstraction in-process
(`backend/app/services/conversion.py`), but the desktop app is a separate
process without access to that storage. The resident engine's
`engine.load_voice` message requires **local file paths**, not inline
bytes (an intentional simplicity tradeoff from Phase 3.1 — see
`docs/phase3.1-resident-engine.md` "IPC Protocol"). Without this endpoint,
the desktop app would have had no way to materialize those files at all.

The endpoint mirrors the existing
`GET /voices/{id}/conversions/{conversion_id}/audio` pattern exactly (same
ownership check, same `storage.read()` call, same `Response(media_type=...)`
shape) — see `backend/app/api/routes/voice_samples.py`. It changes nothing
about existing enrollment, validation, or the offline `/convert` endpoint.
Tested in `backend/tests/integration/test_voice_samples_api.py`.

## Desktop Architecture

```
desktop/src/
├── main/          Electron main process (Node) — process lifecycle only
├── preload/       contextBridge boundary — the ONLY renderer<->main API
├── renderer/      React UI — audio pipeline, EngineClient, screens
└── shared/        protocol.ts, types.ts, ipcApi.ts — single source of
                   truth for both sides of every process boundary
```

**Main** (`src/main/`): `index.ts` (window + app lifecycle, permission
handler), `EngineProcessManager` (spawns/probes/stops the resident engine),
`SettingsStore` (JSON-file preferences, never raw audio),
`voiceReferenceMaterializer.ts` (fetches sample audio from the backend and
writes local temp files for `engine.load_voice`), `platform/` (OS
abstraction), `config.ts` (env-driven, mirrors `ai-worker`/`backend`
conventions), `ipcHandlers.ts` (every `ipcMain.handle` channel).

**Preload** (`src/preload/index.ts`): exposes exactly one global,
`window.voiceshift`, typed by `src/shared/ipcApi.ts`. No `ipcRenderer`, no
Node built-in, no Electron internal crosses this boundary — only the
purpose-built async functions in `VoiceshiftApi`.

**Renderer** (`src/renderer/src/`): `services/EngineClient.ts` (typed
WebSocket client for the resident-engine protocol), `services/BackendClient.ts`
(typed REST client for the existing voice-profile API), `audio/` (PCM math,
chunk accumulation, jitter buffer, output adapter, AudioWorklet capture),
`stores/liveVoiceStore.ts` (the Live Voice state machine — see below),
`hooks/` (`useSettings`, `useEngineStatus`, `useMediaDevices`,
`useVoiceProfiles`), `screens/` (the 5 screens), `components/` (shared UI
primitives: `Card`, `Row`, `StatusBadge`, `LevelMeter`).

## Security

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (see
`src/main/index.ts`). The preload script only calls `contextBridge` +
`ipcRenderer` — no other Node/Electron API. `session.defaultSession.setPermissionRequestHandler`
auto-approves only `media` permission requests from this app's own window
(needed for `getUserMedia`) and denies everything else explicitly, rather
than falling through to a default allow. `will-navigate` blocks navigation
away from `localhost`/`file://`; `setWindowOpenHandler` denies new windows
and routes external links to the OS browser instead.

## Engine Process (`EngineProcessManager`)

Two modes, `VOICESHIFT_ENGINE_MODE=managed` (default) or `=external`.
Managed: spawns `python -m app.main --engine openvoice_onnx serve --host
--port` from `ai-worker/.venv/bin/python` (dev) with `cwd=ai-worker/`,
captures stdout/stderr line-by-line, and readiness is proven by a REAL
protocol round trip (`engine.hello` -> `engine.welcome`), not a bare TCP
connect or a fixed sleep. Graceful shutdown sends `engine.shutdown` and
waits for `engine.shutting_down` before falling back to `SIGTERM`. External
mode never spawns or shuts down the process — only probes it. Exactly one
resident process is ever managed; nothing spawns a new Python process per
audio chunk. `ai-worker`'s own `Settings.engine` still defaults to
`seed_vc`, so `--engine openvoice_onnx` is always passed explicitly by
`main/config.ts` — this is a real, verified detail from reading
`ai-worker/app/main.py`, not an assumption.

## Engine IPC

Zero protocol drift: `desktop/src/shared/protocol.ts` mirrors
`ai-worker/app/server/protocol.py`'s constants and binary framing exactly,
verified two ways — (1) a live round trip against the real running
`serve` process during development (`engine.hello`/`engine.health`
returned exactly the documented shape), and (2) a byte-for-byte
cross-language golden-fixture unit test comparing TS-encoded bytes against
bytes produced by the real Python `encode_audio_frame`/`error_message`.
`EngineClient` (renderer) validates `protocol_version` on connect, tracks
one pending promise per `request_id`, and routes request-id-less messages
(binary-frame-triggered `engine.error`, e.g. `BACKPRESSURE`) to a separate
stream-error stream rather than dropping or crashing on them. A dedicated
integration test (`tests/integration/EngineClient.test.ts`) runs the real
`EngineClient` against a real `ws` WebSocket server
(`tests/integration/fakeEngineServer.ts`) implementing just enough of the
protocol to validate the wire contract without loading OpenVoice.

## Voice Profiles

Electron never retrains or re-enrolls anything. Flow: Voice Profiles
screen lists profiles via the unchanged backend API ->  user picks a
`READY_FOR_AI_PROCESSING` profile -> Live Voice's `startLive()` calls
`window.voiceshift.voiceProfile.prepareLocalReferences(id)` (main process
fetches that profile's VALID samples' audio via the new
`.../samples/{id}/audio` endpoint and writes them to a scratch directory)
-> `EngineClient.loadVoice(id, referencePaths)` -> `engine.voice_loaded`.
Verified end-to-end against the real backend and a real running resident
engine during development (see the Phase 4 final report's "Real Hardware
Verification" section for the exact transcript).

## Microphone Pipeline

`getUserMedia` -> `AudioContext` -> `AudioWorkletNode` (`capture-processor.js`,
real-time-safe only: copies each 128-sample render quantum's per-channel
data and posts it to the main JS thread — no resampling, chunking, or
networking inside the worklet) -> `downmixToMono` (channel-average, never
an interleaved-buffer bug, since Web Audio already delivers separate
per-channel arrays) -> `resampleLinear` to the engine's actual sample rate
-> `ChunkAccumulator` (250/500/750/1000ms, default 500ms — Phase 3.2's
measured-balanced value) -> `EngineClient.sendAudioFrame`.

The target sample rate is **not guessed**: `ai-worker/app/engines/openvoice_onnx.py`
confirms both input and output are `Settings.openvoice_sample_rate`
(22050 by default), and `process_chunk` already calls
`_resample_if_needed()` server-side — the desktop resamples once,
client-side, specifically so that server-side call becomes a no-op,
following the "one explicit resampling boundary" principle rather than
resampling twice. Binary framing is exactly the existing 8-byte
`[sequence:uint32 LE][sample_rate:uint32 LE]` + float32 LE PCM — never
JSON, base64, or per-chunk WAV.

## Converted Audio Playback

`LocalPlaybackAdapter` (the only implemented `AudioOutputAdapter` — Step
28) schedules each converted chunk via the Web Audio API with a
`nextPlayTime` cursor so consecutive chunks queue back-to-back with no gap
and no overlap — never one `HTMLAudioElement` per chunk.
`JitterBuffer` orders frames by their echoed-back sequence number (the
engine returns the same sequence it received), holds an out-of-order
frame until its gap fills or a bounded `maxHoldMs` elapses (then skips the
missing sequence rather than stalling forever), and drops exact duplicates
and late frames — all covered by unit tests including a synthetic
out-of-order/duplicate/skip scenario.

## Live State Machine

`IDLE -> CHECKING -> CONNECTING -> LOADING_VOICE -> STARTING -> LIVE ->
STOPPING -> IDLE`, with `ERROR` reachable from any step
(`src/renderer/src/stores/liveVoiceStore.ts`, a Zustand store with all
dependencies injected — real browser/IPC wiring lives in
`services/singletons.ts`, tests inject fakes). A generation-counter guard
(`sessionEpoch`) prevents a late-arriving async callback (e.g. mic
disconnect firing mid-`await`) from clobbering an already-set `ERROR`/`IDLE`
state back to `LIVE` — a real race the state-machine tests caught and this
guard fixes. Stop never shuts down the engine process — it only calls
`stream.close` and closes this renderer's own WebSocket connection; the
resident engine and its target-voice cache are preserved for the next
session, matching `docs/phase3.1-resident-engine.md`'s documented
unexpected-disconnect behavior.

## Metrics

Only real, measured values are shown — no fabricated CPU% or model-internal
numbers. `processingLatencyMs`/`rtf` are computed **client-side** from
actual send/receive timestamps per sequence number (labeled "capture →
received" and "RTF (est.)" respectively, since they include local IPC
overhead and are not the engine's own internal-only inference timer — the
current protocol has no periodic `stream.metrics` push, only a final
summary at `stream.close`). `queueDepth` is the real count of frames sent
but not yet received or rejected. `droppedChunks`/`endToEndEstimatedLatencyMs`
come directly from the server's real `stream.closed` payload once a session
ends. UI updates are timer-throttled to ~6-7Hz (`METRICS_TICK_MS = 150`),
within the 4-10Hz target — audio processing itself is not throttled.

## Error Handling

Actionable, non-technical messages for: engine unavailable, microphone
denied, voice not ready, microphone disconnected mid-session, engine
connection lost, and genuine protocol errors (`NO_STREAM_OPEN`,
`INVALID_AUDIO_FRAME`) — all mapped in `LiveVoiceScreen.tsx`'s
`actionableErrorMessage()`. Routine `BACKPRESSURE`/`CONVERSION_FAILED`
errors are counted as rejected frames, not treated as session failures,
since the resident engine's own backpressure design (see
`docs/phase3.1-resident-engine.md`) expects the caller to handle rejection
gracefully rather than treating it as fatal.

## Packaging & Distribution (foundation only — Step 45-47)

`desktop/electron-builder.yml` configures Linux (AppImage), Windows
(NSIS), and macOS (DMG) targets. **None of these have been built or run on
their target OS from this Linux development machine** — only the
configuration exists. Two things remain before a real cross-platform
release and are intentionally NOT solved in Phase 4:

1. **Python engine bundling.** `main/config.ts`'s `resolveDevEnginePythonPath()`
   only resolves `ai-worker/.venv/bin/python` relative to the dev repo
   checkout — this does not exist in a packaged build. The intended future
   path: a standalone per-OS Python runtime (e.g. via PyInstaller or a
   similar tool) bundled at `resources/voiceshift-engine/<platform>/`,
   with `EngineProcessManager`'s `pythonPath`/`cwd` resolution branching on
   `app.isPackaged` to point there instead. The abstraction point already
   exists (`EngineProcessManagerOptions.pythonPath`/`cwd` are plain
   strings, resolved once in `main/config.ts`) — only the packaged-path
   resolution itself is undone.
2. **Model distribution.** `ai-worker` currently downloads OpenVoice's ONNX
   weights (~131MB) via `huggingface_hub` on first engine load into
   `~/.voiceshift/models/` (see `ai-worker/README.md`). For an end-user
   installer, the options are: first-run download (simplest, requires
   internet on first launch), installer-bundled (larger installer, works
   offline), or a separate downloadable model package with checksum
   verification. None is implemented; whichever is chosen must not change
   the existing MIT/GPL-3.0 licensing disclosures in
   `docs/model-selection.md`.

## Platform Abstraction (Step 48)

`src/main/platform/index.ts` defines `PlatformAudioIntegration` with
`LinuxDevIntegration` (implemented and exercised — this dev machine),
`WindowsIntegration`, and `MacOSIntegration` (both documented stubs
returning `supportsVirtualAudioOutput() === false` and a hint of the
expected future virtual device name — VB-CABLE / BlackHole — but no real
integration). `src/renderer/src/audio/outputAdapter.ts` defines the
separate, renderer-side `AudioOutputAdapter` interface the same way:
`LocalPlaybackAdapter` implemented now, `WindowsVirtualAudioAdapter`/
`MacVirtualAudioAdapter` documented as Phase 5 work that must not require
changes to mic capture, `EngineClient`, or the state machine — the
interface boundary already guarantees that, since every caller depends
only on `AudioOutputAdapter`, never on `LocalPlaybackAdapter` directly.
