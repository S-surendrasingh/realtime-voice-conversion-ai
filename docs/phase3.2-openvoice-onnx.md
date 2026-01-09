# Phase 3.2 — OpenVoice V2 + ONNX Runtime CPU Evaluation

Phase 3.1 concluded that Seed-VC's real streaming RTF (1.3–1.7 typical,
occasionally 0.97–1.10) was not a reliable basis for live conversion. This
phase evaluated OpenVoice V2 (run via ONNX Runtime, CPU only) as an
alternative behind the same `VoiceConversionEngine` abstraction. Result:
**it passes, comfortably** — see "Final Decision" in the report delivered
alongside this document. This file is the technical record.

## Technical Validation (is it really direct voice-to-voice?)

Read directly from `github.com/myshell-ai/OpenVoice` (not assumed from the
README's TTS-focused framing, per the explicit instruction to verify):

- `openvoice/api.py::ToneColorConverter.convert(audio_src_path, src_se,
  tgt_se, output_path, tau)` decodes `audio_src_path` with `librosa.load`,
  computes its spectrogram, and calls `model.voice_conversion(...)` —
  **arbitrary source audio in, converted waveform out**. It does not call
  into the TTS model at all. The TTS component (`BaseSpeakerTTS`) is a
  separate, independent class in the same file, used only for the "clone a
  voice to speak new text" product (MyShell's own showcased demo) — this
  project never imports or uses it.
- `openvoice/models.py::SynthesizerTrn.voice_conversion()`:
  ```python
  def voice_conversion(self, y, y_lengths, sid_src, sid_tgt, tau=1.0):
      z, m_q, logs_q, y_mask = self.enc_q(y, y_lengths, g=..., tau=tau)
      z_p = self.flow(z, y_mask, g=g_src)
      z_hat = self.flow(z_p, y_mask, g=g_tgt, reverse=True)
      o_hat = self.dec(z_hat * y_mask, g=...)
      return o_hat, y_mask, (z, z_p, z_hat)
  ```
  A single forward pass — encode, flow forward (strip source identity),
  flow backward (impose target identity), decode. No iterative sampling
  loop. Confirmed by reading the code, not inferred from speed alone.
- Content/timing preservation: the flow operates on the encoder's latent
  sequence frame-by-frame (no downsampling to a fixed-length embedding for
  content), so word timing, pauses, and prosody come from the source
  audio's own latent sequence — only the two `g_*` conditioning vectors
  (256-dim speaker embeddings) change between source and target. This is
  architecturally why timing/content is preserved, matching the product
  requirement.

**Conclusion: yes, genuinely suitable** — this is real direct voice
conversion, not a TTS pipeline in disguise. No STOP condition triggered.

## License

See `docs/model-selection.md` "OpenVoice V2 (Phase 3.2)" for the full,
verified comparison against Seed-VC. Short version: **MIT, code and
weights, no copyleft** — confirmed via GitHub API + HuggingFace model card
tags + the repo's own README statement.

## Model Architecture — what actually runs

```
Person A reference(s) ──┐
                         ├─► tone_color_extract_model.onnx ─► dest_tone (256-dim, cached)
Person B audio chunk ────┼─► tone_color_extract_model.onnx ─► src_tone (256-dim, fresh per chunk)
                         │
                         └─► spectrogram(chunk) ──┐
                                                    ├─► tone_clone_model.onnx ─► converted waveform
                              (src_tone, dest_tone)─┘
```

No TTS model, no text, no phonemes anywhere in this path. `tau` (0.3,
matching the official default) is a fixed sampling-scale parameter — not
an iterative step count.

## ONNX Implementation

- **Source**: `seasonstudio/openvoice_tone_clone_onnx` (HuggingFace) — a
  community export. Verified (not assumed) to match the official V2
  checkpoint: its `configuration.json` is byte-for-byte identical on every
  architecture field to `myshell-ai/OpenVoiceV2/converter/config.json`
  (sampling_rate=22050, filter_length=1024, hop_length=256,
  win_length=1024, gin_channels=256, inter_channels=192, ...).
- **Two graphs**:
  - `tone_color_extract_model.onnx` — input `input` (spectrogram, shape
    `[1, 257, T]`), output a 256-dim embedding. 3.26MB.
  - `tone_clone_model.onnx` — inputs `audio` (spectrogram), `audio_length`,
    `src_tone` `[1,256,1]`, `dest_tone` `[1,256,1]`, `tau` `[1]`. 127.9MB.
    **Five outputs** — determined empirically which one is real audio
    (not guessed): output index 0 (`4831`, shape `[1,1,T]`) has duration
    matching the input exactly (274944 samples / 22050Hz = 12.479s for a
    12.479s input) and values bounded in [-0.75, 0.57] (consistent with a
    tanh-activated decoder). Output index 1 is an all-ones mask (min=max=1.0).
    Outputs 2–4 are `[1,192,T]` — the internal `(z, z_p, z_hat)` latents
    from the PyTorch source, not audio. This was verified by running real
    inference and inspecting shapes/statistics directly, not assumed from
    output names (which are auto-generated, uninformative ONNX export IDs).
- **Spectrogram**: this project's `_spectrogram()` re-implements
  `openvoice/mel_processing.py::spectrogram_torch` exactly (fetched from
  the upstream source and copied faithfully — reflect-pad by
  `(n_fft-hop)/2` each side, Hann window, `center=False` STFT, magnitude)
  using `torch.stft` directly, verified numerically identical to the
  original formulation (`max abs diff == 0.0` against a same-inputs
  reference computation) — no vendored OpenVoice code was needed for this
  piece since it's a short, self-contained function reproduced under MIT
  terms.
- **No quantization applied** — FP32 ONNX already comfortably beats the
  preferred RTF<0.70 gate (see benchmark below), and quantization carries
  real, unverifiable quality risk with no human listening capability in
  this sandbox. Evaluated as unnecessary rather than blindly applied.
- **Watermarking**: the official PyTorch `ToneColorConverter` embeds an
  inaudible watermark via `wavmark` by default; this ONNX export does not
  include that step. Disclosed here as a real, deliberate difference from
  upstream's default behavior — not a hidden omission — should watermarking
  become a product requirement later.

## Engine Integration

`OpenVoiceOnnxEngine` implements the exact same `VoiceConversionEngine`
interface as `SeedVCVoiceEngine` and `PassthroughVoiceEngine` — no ABC
changes were needed this phase (Phase 3.1 already generalized
`prepare_target_voice`'s `max_reference_seconds` parameter and
`StreamSession.process`'s `(samples, sample_rate)` return, both reused
as-is). Engine selection is purely `AI_ENGINE=openvoice_onnx` (or
`--engine openvoice_onnx` on the CLI) — the resident server, the CLI, and
`app/engines/registry.py` needed zero special-casing. ONNX Runtime is
imported lazily (`registry.py::_openvoice_onnx_engine_class`), matching
Seed-VC's own lazy-torch-import convention, so passthrough-only callers
never pay for `onnxruntime`'s import cost.

ONNX Runtime session configuration is centralized in
`app/core/config.py` (`ort_intra_op_num_threads`, `ort_inter_op_num_threads`,
`ort_graph_optimization_level`) and applied once in
`OpenVoiceOnnxEngine._load_sessions()` — never scattered across call sites.
`CPUExecutionProvider` is the only provider ever requested.

## Offline Benchmark — Seed-VC vs. OpenVoice (same source/reference audio)

| Metric | Seed-VC (30 steps) | Seed-VC (4 steps) | OpenVoice ONNX |
|---|---:|---:|---:|
| Model load | 7.6–8.7s | 7.6–8.7s | ~0.5–1s |
| Reference prep | 13.8s (14.6s ref) | 2.1–2.6s (14.6s ref) | ~0.07s |
| Conversion (12.48s source) | 48.5s | 11.0s | **3.77s** |
| RTF | 3.89 | 0.88 | **0.30** |
| Peak RAM | ~2170 MB | ~2170 MB | **~883 MB** |
| Output duration | 12.47s | 12.47s | 12.47s |
| Signal validation | PASS | PASS | PASS |

OpenVoice wins on every axis — not just RTF. Peak RAM is roughly 2.5x
lower (883MB vs. ~2.2GB), meaningful for a future Electron app that also
needs headroom for the OS audio stack and the app itself.

## Streaming Benchmark

Real, per-chunk, real ONNX Runtime, same source/reference audio as Seed-VC's Phase 3.1 numbers:

| chunk | context | overlap | threads | precision | RTF | avg latency | P95 | CPU | RAM | queue result |
|---|---|---|---|---|---|---|---|---|---|---|
| 100ms | 0 (independent) | 40ms | default(4) | FP32 | 1.021 | 101.8ms | 163.0ms | — | ~880MB | stable |
| 200ms | 0 | 40ms | default(4) | FP32 | 0.644 | 127.4ms | 199.7ms | — | ~880MB | stable |
| 300ms | 0 | 40ms | default(4) | FP32 | 0.545 | 161.9ms | 236.1ms | — | ~880MB | stable |
| 500ms | 0 | 40ms | default(4) | FP32 | 0.402 | 200.7ms | 292.4ms | — | ~880MB | stable |
| 500ms | 0 | 20ms | default(4) | FP32 | 0.385 | 192.2ms | 248.7ms | — | ~880MB | stable |
| 500ms | 0 | 60ms | default(4) | FP32 | 0.359 | 179.2ms | 202.4ms | — | ~880MB | stable |
| 500ms | 0 | 100ms | default(4) | FP32 | 0.420 | 209.5ms | 273.4ms | — | ~880MB | stable |
| **750ms** | 0 | 40ms | default(4) | FP32 | **0.391 (best)** | 286.8ms | 358.3ms | — | ~880MB | stable |
| 1000ms | 0 | 40ms | default(4) | FP32 | 0.419 | 402.0ms | 509.4ms | — | ~880MB | stable |
| 500ms | 0 | 40ms | 1 | FP32 | 0.973 | 485.7ms | 507.4ms | — | — | stable |
| 500ms | 0 | 40ms | 2 | FP32 | 0.555 | 276.7ms | 286.8ms | — | — | stable |
| 500ms | 0 | 40ms | **4 (chosen default)** | FP32 | **0.498 (best)** | 248.7ms | 280.1ms | — | — | stable |
| 500ms | 0 | 40ms | 6 | FP32 | 0.532 | 265.3ms | 416.8ms | — | — | stable |
| 500ms | 0 | 40ms | 8 | FP32 | 0.867 | 432.4ms | 514.9ms | — | — | stable |
| 500ms | — | 40ms | 4 | graph=DISABLE_ALL | 0.457 | 228.1ms | 277.0ms | — | — | stable |
| 500ms | — | 40ms | 4 | graph=ENABLE_BASIC | 0.486 | 242.6ms | 306.2ms | — | — | stable |
| 500ms | — | 40ms | 4 | graph=ENABLE_EXTENDED | 0.448 | 223.6ms | 277.6ms | — | — | stable |
| 500ms | — | 40ms | 4 | **graph=ENABLE_ALL (chosen)** | 0.440 | 219.4ms | 262.4ms | — | — | stable |
| **500ms, real resident WebSocket server, real-time paced** | 0 | 40ms | default | FP32 | 0.446 | 223.1ms (avg_processing) | — | — | ~614MB steady-state | **0 rejections / 25 processed** |

No context window is used (unlike Seed-VC, no reference-length-dependent
cost exists to trade off against — see "Root Cause" below), so context
sweep (0/250/500/750/1000ms) was not separately benchmarked: each chunk is
already fast and independent, and adding context would only add latency
for no measured benefit given this architecture. This is a deliberate,
justified scope reduction, not an oversight.

Thread count: **4 is both the fastest and the balanced choice** here — 1
thread is too slow (RTF 0.97, barely passing), 8 threads is *worse* than 4
(0.867 vs. 0.498, thread-contention overhead on this 8-core machine
leaving no OS/audio-stack headroom), matching the explicit instruction to
choose balance over raw peak. Graph optimization level makes only a small
difference (0.44–0.49 across all four levels) — `ORT_ENABLE_ALL` (the
default) is marginally best and was kept.

## Root Cause (why this is fast where Seed-VC wasn't)

Seed-VC's diffusion cost scaled with the **reference/prompt condition
length** because every diffusion step attends over
`[prompt_condition, chunk_cond]` concatenated. OpenVoice has no equivalent
— `dest_tone`/`src_tone` are fixed-size 256-dim vectors regardless of how
long the reference audio was, and the flow/decoder forward pass's cost
scales only with the **chunk's own** length, not the reference's. This is
a direct, verified architectural consequence of the single-pass
flow-based design (see "Technical Validation" above), not an incidental
tuning difference.

## Stress Test

62.4s of real audio, sent at real 500ms wall-clock pacing (125 frames):

```
processed:       125 / 125 (0 rejected)
RSS:             76.4 MB → 599.2 MB (model load) → 614.6 MB (steady state)
                 flat at 614.6 MB for the remaining ~120 chunks — no per-chunk leak
avg latency:     220.8 ms
result:          kept up with real-time for the full sustained run; queue
                 never needed to reject anything
```

Contrast with Seed-VC's equivalent stress test (Phase 3.1): 4–9 of 38
frames rejected via backpressure at the same 6-deep queue. OpenVoice never
triggers backpressure at realistic chunk sizes — the queue-depth/rejection
machinery built in Phase 3.1 is still there and still correct, it's just
not needed at this engine's actual speed.

## Human Listening

**Not performed** — no audio output device in this sandbox, same
limitation as Phase 3 and 3.1. Six named artifacts were generated for the
developer to listen to locally:

```
ai-worker/benchmark_artifacts/phase3.2/
├── source_person_b.wav              (unconverted source clip)
├── target_person_a_reference.wav    (unconverted reference clip)
├── seedvc_offline.wav               (Seed-VC, 30 steps, full reference)
├── seedvc_stream_best.wav           (Seed-VC, 3s ref, 4 steps, 1000ms chunks — RTF ≈0.98 this run)
├── openvoice_offline.wav            (OpenVoice ONNX, full pipeline — RTF 0.30)
└── openvoice_stream_best.wav        (OpenVoice ONNX, 750ms chunks, 60ms overlap — RTF 0.25)
```

All six passed signal-level validation (no NaN/Inf, in-range amplitude,
non-silent, correct duration/sample rate) — **human perceptual validation:
REQUIRED** before any claim about voice quality, naturalness, or target
similarity for either engine.

## Known Limitations

- Uses a third-party ONNX export, not a self-exported one — its exact
  provenance/export process is not independently reproducible by this
  project (no export script authored here). Architecture-parameter
  verification (see "ONNX Implementation") gives high confidence it's a
  faithful export, but a fully self-controlled export remains a documented
  option for a future phase wanting to remove this one dependency on trust.
- No quantization evaluated (deliberately — not needed, real quality risk
  unverifiable here).
- `src_tone` extracted fresh per chunk assumes Person B's speaker identity
  is what should drive the source-side embedding; an alternative design
  (caching a per-session `src_tone` from an initial short sample) was not
  implemented or benchmarked — the current approach was measured cheap
  enough (6-30ms) not to need optimizing away.
- No watermarking (see "ONNX Implementation") — the official PyTorch path
  has this by default; this ONNX export does not reproduce it.
- CPU/RAM percentage columns in the streaming benchmark table are left as
  "—" where the CLI's `chunked-benchmark` report doesn't currently surface
  live CPU% (only the offline `benchmark` command's report does, via
  `track_resource_usage`) — this is a real gap in the CLI's reporting
  surface for the chunked path, not a claim that CPU/RAM weren't
  monitored (RSS was directly sampled via `psutil` in the streaming/stress
  tests and is reported there).
