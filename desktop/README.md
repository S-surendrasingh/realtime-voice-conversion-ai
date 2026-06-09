# desktop

Electron + React + TypeScript desktop application — the primary live
product for real-time AI voice conversion (Phase 4). The existing Next.js
`frontend/` remains for enrollment/diagnostics only; this app is where
Live Voice actually runs. See `../docs/phase4-desktop.md` for full
architecture.

No GPU, no CUDA, no cloud inference — this app is a client of the existing
CPU-only resident engine in `../ai-worker`.

## Setup

```bash
cd desktop
npm install
```

## Development

Requires the backend (`../backend`) and, unless using managed engine mode,
the resident AI engine already running:

```bash
# in ai-worker/, with its own venv active
python -m app.main --engine openvoice_onnx serve
```

Then, from `desktop/`:

```bash
npm run dev
```

### Environment variables (all optional, sensible defaults)

- `VOICESHIFT_ENGINE_MODE` — `managed` (default, Electron starts/stops the
  engine) or `external` (you start it yourself, as above).
- `VOICESHIFT_ENGINE_HOST` / `VOICESHIFT_ENGINE_PORT` — default
  `127.0.0.1:8765`, matching `ai-worker`'s own defaults.
- `VOICESHIFT_ENGINE_PYTHON` / `VOICESHIFT_ENGINE_CWD` — override the
  resolved dev paths to `ai-worker/.venv/bin/python` and `ai-worker/`.
- `VOICESHIFT_API_URL` — backend base URL, default `http://127.0.0.1:8000`.

## Tests

```bash
npm run test        # vitest — unit, component, and integration tests
npm run typecheck   # tsc, renderer + main/preload projects
npm run lint        # eslint
```

## Build

```bash
npm run build           # electron-vite build -> out/
npm run build:unpack    # + electron-builder --dir (unpacked, Linux only —
                         # see ../docs/phase4-desktop.md "Packaging &
                         # Distribution" before attempting a real installer)
```

## Structure

```
src/
├── main/       Electron main process: window, EngineProcessManager,
│               SettingsStore, platform/, IPC handlers
├── preload/    contextBridge boundary — window.voiceshift, nothing else
├── renderer/   React UI: services (EngineClient/BackendClient), audio/
│               pipeline, stores/ (live-voice state machine), hooks/,
│               screens/, components/
└── shared/     protocol.ts (mirrors ai-worker's IPC protocol exactly),
                types.ts, ipcApi.ts — single source of truth for every
                process boundary
tests/
├── unit/           pure logic — protocol, audio math, state machine
├── main/           EngineProcessManager with mocked child_process/ws
├── integration/    real EngineClient against a real fake WebSocket server
└── components/     screens, via Vitest + React Testing Library
```
