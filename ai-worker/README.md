# ai-worker

CPU-only voice conversion engine for the Realtime AI Voice Conversion
platform. A separate Python package/runtime from `backend/` — see
`../docs/phase3-ai-conversion.md` for why.

**Default engine: `openvoice_onnx`** (OpenVoice V2 via ONNX Runtime, **MIT
licensed**) — selected in Phase 3.2 after real streaming benchmarks showed
it reliably beats real-time (RTF 0.30–0.65 typical) where Seed-VC did not
(RTF 1.3–1.7 typical). Seed-VC (`seed_vc`, **GPL-3.0 licensed**) remains
fully intact for comparison/offline fallback. See
`../docs/model-selection.md` for both models' verified licenses before
distributing anything that bundles this package, and
`../docs/phase3.2-openvoice-onnx.md` for the full benchmark comparison.

No GPU, no CUDA, no cloud inference. `AI_DEVICE=cpu` is enforced in code
for every engine, not just configuration.

## Setup

Requires Python 3.10 (pyenv: `pyenv install 3.10.14`).

```bash
cd ai-worker
python3.10 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -e ".[dev]"   # also installs onnxruntime (CPU build) for openvoice_onnx

# Seed-VC's engine code is vendored from the upstream repo (GPL-3.0 — not
# redistributed as part of this project's own history, see .gitignore).
# Only needed if you plan to use --engine seed_vc.
mkdir -p vendor && git clone --depth 1 https://github.com/Plachtaa/seed-vc.git vendor/seed-vc
```

Model weights are **not** part of this repo — they download automatically
(HTTPS, via `huggingface_hub`) into `~/.voiceshift/models/` the first time
an engine loads:
- `openvoice_onnx`: ~131MB (two ONNX graphs), peak RSS ~880MB.
- `seed_vc`: ~1.5-2GB (DiT checkpoint + a 300M-param wav2vec2 feature
  extractor + vocoder), peak RSS ~2.2GB. See `docs/model-selection.md`.

## CLI

The CLI is the interface the FastAPI backend's offline `/convert` endpoint
talks to (invoked as a subprocess). Every command prints exactly one JSON
result as its last stdout line; logging goes to stderr. Works identically
regardless of which engine is selected — `--engine openvoice_onnx`,
`--engine seed_vc`, or `--engine passthrough`.

```bash
# Offline conversion (prepare + convert in one call)
python -m app.main --engine openvoice_onnx convert \
  --source ./samples/person_b.wav \
  --reference ./samples/person_a.wav \
  --output ./outputs/converted.wav

# Prepare once, convert many times against the cached artifact
python -m app.main --engine openvoice_onnx prepare --reference ref1.wav --output target.npy
python -m app.main --engine openvoice_onnx convert --source source.wav --prepared-voice target.npy --output out.wav

# Chunk-by-chunk conversion — with openvoice_onnx this is genuinely fast
# per chunk; with seed_vc it is not (see docs/phase3.1-resident-engine.md
# "Root Cause") and streaming with it is not recommended
python -m app.main --engine openvoice_onnx chunked-convert --source source.wav --reference ref.wav \
  --output chunked.wav --chunk-ms 500 --overlap-ms 40

# Benchmarks
python -m app.main --engine openvoice_onnx benchmark --source source.wav --reference ref.wav
python -m app.main --engine openvoice_onnx chunked-benchmark --source source.wav --reference ref.wav \
  --chunk-sizes 100,200,300,500,750,1000

# Per-stage timing breakdown (Phase 3.1 profiling tool)
python -m app.main --engine seed_vc profile-chunk --source source.wav --reference ref.wav --chunk-ms 500

# Resident streaming engine (Phase 3.1/3.2 — local WebSocket, see docs/phase3.1-resident-engine.md)
python -m app.main --engine openvoice_onnx serve

# Health (add --deep to actually load the model, not just check config)
python -m app.main --engine openvoice_onnx health-check
```

Pass `--engine passthrough` (identity pass-through, no ML dependencies) for
fast, deterministic testing — this is what the backend's own test suite
uses, and what CI-style runs should use to avoid downloading real weights.

## Tests

```bash
pytest                 # unit + integration (fake engines, fast, no downloads)
pytest -m ai            # real model smoke tests — downloads real weights (both engines)
pytest -m performance    # real streaming/throughput benchmarks — slow, real weights
pytest --cov=app --cov-report=term-missing
```

## Resident streaming engine

`python -m app.main serve` starts a local WebSocket server (binds
`127.0.0.1` only) that loads the selected engine once and keeps it
resident across many stream sessions — built in Phase 3.1, engine-agnostic
(works with either `seed_vc` or `openvoice_onnx`). Full protocol and
architecture: `../docs/phase3.1-resident-engine.md`. This is separate from
and does not affect the backend's existing offline `/convert` endpoint,
which still invokes the CLI as a subprocess per request.

## Structure

```
app/
├── core/        settings, logging, explicit AI_* error codes, ONNX Runtime session config
├── engines/     VoiceConversionEngine (ABC) + PassthroughVoiceEngine + SeedVCVoiceEngine + OpenVoiceOnnxEngine
├── audio/       validation, preprocessing, postprocessing, chunking, crossfade, RTF/latency metrics, profiling
├── voices/      deterministic reference selection, cache-key computation, prepared-voice metadata
├── conversion/  orchestrates prepare+convert for the CLI
├── benchmark/   offline + chunked benchmark runner and report formatting
├── server/      resident engine: WebSocket IPC protocol, engine manager, bounded streaming sessions
└── main.py      CLI entry point
vendor/seed-vc/  upstream Seed-VC source, GPL-3.0, not committed to this project's own history
benchmark_artifacts/  human-listening WAVs from real benchmark runs, not committed (see .gitignore)
```
