# Model Selection (Phase 3)

**Update (Phase 3.2): the active default engine is now `openvoice_onnx`**,
not Seed-VC — see "OpenVoice V2 (Phase 3.2)" below for why. Seed-VC remains
fully intact in the codebase (`seed_vc` engine option) for comparison and
as an offline fallback; nothing about it was removed or degraded. This
section is kept as the original Phase 3 record.

## Chosen model (Phase 3 — Seed-VC)

**Seed-VC**, specifically the `seed-uvit-tat-xlsr-tiny` checkpoint —
`DiT_uvit_tat_xlsr_ema.pth` (a 25M-parameter diffusion transformer), paired
with a frozen `facebook/wav2vec2-xls-r-300m` feature extractor, a CAMPPlus
speaker/style encoder, and a HiFTGenerator vocoder.

- Upstream project: <https://github.com/Plachtaa/seed-vc> (verified current
  and actively the canonical source as of 2026-08 — confirmed via the live
  repository, not from training-data memory, per the explicit instruction
  not to trust a possibly-stale prior understanding of this project).
- Weights: <https://huggingface.co/Plachta/Seed-VC>
  (`DiT_uvit_tat_xlsr_ema.pth` + `config_dit_mel_seed_uvit_xlsr_tiny.yml`).
- This is **direct, zero-shot voice-to-voice conversion** (waveform in,
  waveform out) — not an STT→TTS pipeline. It preserves Person B's timing,
  pronunciation, and pauses while transforming vocal identity toward the
  prepared target voice, per the product requirement.

### Why this checkpoint specifically

The upstream README's own checkpoint table (fetched live, not from memory):

| Checkpoint | Size | Purpose |
|---|---|---|
| `seed-uvit-tat-xlsr-tiny` | 25M | Real-time voice conversion |
| `seed-uvit-whisper-small-wavenet` | 98M | Offline voice conversion |
| `seed-uvit-whisper-base` | 200M | Singing voice conversion |

`xlsr-tiny` is upstream's own recommendation for real-time/low-latency use,
matching this project's CPU-only goal — the other checkpoints are larger
and explicitly positioned for offline/singing use, not real-time.

**Caveat found during integration**: "tiny" describes only the 25M DiT
diffusion transformer. The full pipeline also loads a **300M-parameter**
frozen `wav2vec2-xls-r-300m` feature extractor (the actual heaviest
component, ~1.2GB), a CAMPPlus speaker encoder, and a HiFTGenerator
vocoder. Total measured peak RSS during CPU inference was **~2.2GB** — not
"tiny" end-to-end. This is reported honestly rather than assumed from the
checkpoint's name.

## License — read this before distributing anything

**Both the seed-vc code and the `Plachta/Seed-VC` model weights are
licensed GPL-3.0** (confirmed by fetching the actual `LICENSE` file from
the repository and the license badge on the HuggingFace model card — not
assumed from a "usually permissive" prior).

Practical implications:

- **Local development, benchmarking, and personal/internal use (this
  phase): no issue.** Running GPL-3.0 code locally and generating output
  with it does not itself trigger GPL's copyleft obligations.
- **Distribution is where GPL-3.0 matters.** If a future phase ships a
  binary/installer (e.g. the planned Phase 4 Electron app) that bundles or
  links against this code, GPL-3.0's copyleft terms would generally apply
  to the combined work — meaning the distributed application would need to
  also be made available under GPL-3.0-compatible terms, with source access
  provided to recipients.
- **This is exactly why the AI worker is invoked as a separate subprocess**
  (see `docs/phase3-ai-conversion.md`) rather than imported as a library
  into the backend or bundled directly into a differently-licensed
  process — process-boundary invocation is the common way projects use a
  GPL tool without their own code being considered a "derivative work" of
  it, though this is not itself a substitute for a real legal review before
  any commercial distribution decision.
- **No weights are committed to this repository.** They are downloaded at
  runtime into a local cache (see "Model file management" below) —
  redistributing the weights themselves would carry the same GPL-3.0 terms
  as the code.

**Recommendation**: before Phase 4 (Electron, real distribution to end
users) ships anything bundling this model, get a real legal review of the
GPL-3.0 distribution implications specific to the intended distribution
model. This document is an engineering-level license disclosure, not legal
advice.

## Commercial-use / redistribution / attribution

- GPL-3.0 permits commercial use.
- Redistribution (of the code or a derivative work) must be under
  GPL-3.0-compatible terms, with source made available.
- No separate attribution clause beyond GPL-3.0's own requirements (retain
  copyright/license notices).

## Runtime dependency footprint

The upstream repo's own `requirements.txt` is GPU-first and demo-oriented —
it pins CUDA nightly torch wheels and includes Gradio, `sounddevice`,
`FreeSimpleGUI`, `modelscope`, `funasr`, `resemblyzer`, `jiwer`,
`hydra-core`, and `descript-audio-codec`, none of which are needed just to
run inference. Per the explicit instruction not to blindly copy that file,
`ai-worker/pyproject.toml` installs only:

```
torch, torchaudio, torchvision   (CPU wheels — download.pytorch.org/whl/cpu, NEVER the CUDA index)
transformers, librosa, huggingface-hub, einops, munch, pyyaml
soundfile, numpy, scipy, psutil
descript-audio-codec              (see below — a real, non-optional transitive dependency)
pydantic-settings
```

**`descript-audio-codec` was NOT an assumption** — it was discovered by
actually attempting to load the model: `modules/length_regulator.py`
unconditionally imports `dac.nn.quantize.VectorQuantize` at module load
time, even though this checkpoint's config sets `vector_quantize: false`
and never instantiates it. Excluding it (as the "avoid a demo repo's full
requirements.txt" guidance would suggest) breaks model construction
entirely. It's a small, real, non-training, non-demo dependency, so it's
kept.

Explicitly **excluded** (verified unnecessary for inference of this
checkpoint): Gradio, `FreeSimpleGUI`, `sounddevice`, `modelscope`, `funasr`,
`resemblyzer`, `jiwer`, `hydra-core`, `python-dotenv`, and all CUDA-indexed
wheels.

## CPU-only enforcement

`ai-worker/app/engines/seed_vc.py` never calls `torch.cuda.is_available()`
— the module-level `_DEVICE = torch.device("cpu")` is hardcoded, and
`CUDA_VISIBLE_DEVICES=""` is set defensively at load time. This is a
deliberate rewrite, not a config flag on top of upstream's own
`inference.py`, which does branch on `cuda if available` — see
`docs/phase3-ai-conversion.md` for the specific reasons upstream's driver
script could not be reused as-is on CPU (its xlsr code path also calls
`.half()` unconditionally, which is unsafe on most CPU PyTorch builds; this
project's rewrite stays in float32 throughout).

## Model file management

- Cache directory: `~/.voiceshift/models/` by default (`AI_MODEL_CACHE_DIR` env
  var to override) — never committed to git (`ai-worker/.gitignore` excludes
  `models/`, `*.pt`, `*.pth`, `*.bin`). All `huggingface_hub`-downloaded files
  (the DiT checkpoint/config, the HiFT vocoder, and the wav2vec2-xls-r-300m
  feature extractor) are routed through this same directory via an explicit
  `cache_dir=` argument — none fall back to `transformers`'/`huggingface_hub`'s
  own default `~/.cache/huggingface/`. A `manifest.json` is additionally
  written under `~/.voiceshift/models/<model-version>/` specifically (see
  below) — only that one file lives in a version-namespaced subpath.
- Downloaded via `huggingface_hub.hf_hub_download` — **HTTPS only** (the
  Hub SDK never falls back to plaintext).
- **Checksum**: a `manifest.json` is written next to the checkpoint after
  every successful load, containing a locally-computed SHA-256 of the
  downloaded file, its byte size, source URL, and license string (see
  `SeedVCVoiceEngine._write_manifest`). This is a local integrity record,
  not a signature check against a checksum the model author published
  separately — HuggingFace Hub itself does verify transfer integrity
  during download (via its own content hashing), but no independently
  published checksum exists to compare against beyond that.
- Failure mode: a download or load failure raises
  `AIErrorCode.MODEL_DOWNLOAD_FAILED` / `MODEL_LOAD_FAILED` — never a raw
  stack trace to a caller (see `app/core/errors.py`).
- No arbitrary code is ever downloaded or executed — only declared model
  weight files and YAML configs, loaded via `torch.load`/`yaml.safe_load`.

---

## OpenVoice V2 (Phase 3.2) — the new default engine

Selected after Seed-VC's real streaming RTF proved unreliable (typically
1.3–1.7, occasionally 0.97–1.10 — see `docs/phase3.1-resident-engine.md`).
Every claim below was independently verified this phase — none carried
over from prior notes without re-checking against the live repository.

- Upstream: <https://github.com/myshell-ai/OpenVoice> (not archived, last
  pushed 2025-04-19, 37k+ stars — confirmed via the GitHub API, not memory).
- Weights: <https://huggingface.co/myshell-ai/OpenVoiceV2> (official).
- **Direct waveform-to-waveform voice conversion — verified by reading the
  actual source**, not assumed from the README's TTS-focused marketing.
  `openvoice/api.py::ToneColorConverter.convert(audio_src_path, src_se,
  tgt_se, ...)` takes an arbitrary source audio file directly; it does not
  require or depend on the bundled TTS model (`BaseSpeakerTTS`/MeloTTS) —
  that's a separate, optional component used only for the "clone a voice
  for TTS output" use case, which this project does not use.
- **Not iterative.** `openvoice/models.py::SynthesizerTrn.voice_conversion()`
  is a single forward pass — posterior encoder → normalizing flow → the
  same flow run in reverse → decoder. There is no diffusion sampling loop.
  This is the structural reason it is faster on CPU than Seed-VC's
  diffusion transformer, confirmed by reading the model code directly, not
  inferred from benchmark numbers alone.
- Requires **two** speaker embeddings per conversion — `src_se` (the
  audio being converted) and `tgt_se` (the target voice) — both produced
  by a small reference encoder (`extract_se()`), not a heavy sequence
  encoder. This project extracts `src_tone` fresh per chunk (measured
  cost: 6–30ms, not a bottleneck) rather than caching it, since a live
  Person B's tone can drift between utterances; `dest_tone` (Person A) is
  cached exactly like Seed-VC's target-voice artifact.
- **Built-in watermarking**: the official `ToneColorConverter` embeds an
  inaudible watermark (via `wavmark`) into every conversion by default.
  The ONNX export used here does not include this step (see "ONNX
  Implementation" in `docs/phase3.2-openvoice-onnx.md`) — a real,
  disclosed difference from the official PyTorch reference implementation,
  not a silent omission.

### License

**MIT — both code and weights**, confirmed via the GitHub API's license
field and the HuggingFace model card's `license:mit` tag, and stated
explicitly in the repo's own README ("OpenVoice V1 and V2 are MIT
Licensed. Free for both commercial and research use"). This is a
materially simpler distribution posture than Seed-VC's GPL-3.0:

| | Seed-VC | OpenVoice V2 |
|---|---|---|
| Code license | GPL-3.0 | MIT |
| Weights license | GPL-3.0 | MIT |
| Commercial use | Permitted, but distributing a bundled app generally requires the combined work to also be GPL-3.0-compatible with source available | Permitted, no copyleft — a bundled Phase 4 Electron app would not need to be relicensed |
| Attribution | GPL-3.0's own notice-retention requirement | None beyond MIT's own notice-retention requirement |

No legal conclusion is drawn here — this is an engineering-level
comparison of distribution obligations, not legal advice; a real
distribution decision still warrants real legal review.

### ONNX export used

No official ONNX weights are published by myshell-ai. This project uses
a **community export**, `seasonstudio/openvoice_tone_clone_onnx`
(HuggingFace), verified — not assumed — to be a faithful export of the
official V2 converter checkpoint: its bundled `configuration.json` is
**identical** (sampling_rate, filter_length, hop_length, win_length,
gin_channels, inter_channels, and every other architecture parameter) to
the official `myshell-ai/OpenVoiceV2/converter/config.json`. Its own
license is not explicitly stated by the exporter; since it is a direct,
parameter-for-parameter re-export of an MIT-licensed model with no added
training or modification, it is treated as inheriting the same MIT terms
— flagged here explicitly as an inference, not a licensing guarantee, in
case a future phase wants a fully self-exported (and therefore
unambiguously licensed) alternative. See `docs/phase3.2-openvoice-onnx.md`
"ONNX Implementation" for the full verification process (I/O shapes,
which output tensor is actually audio, numerical sanity).

### Model file management

Same conventions as Seed-VC: cached under `~/.voiceshift/models/` via
`huggingface_hub.hf_hub_download` (HTTPS only), a `manifest.json` written
with a locally-computed SHA-256 checksum, size, source, and license after
every load. No weights committed to git (`ai-worker/.gitignore` also
excludes `*.npy`, the artifact format this engine's target-voice cache
uses).
