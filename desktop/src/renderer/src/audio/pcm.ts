/** Pure PCM math — mono downmix and resampling. Kept separate from the
 * AudioWorklet (which does only real-time-safe capture) and separate from
 * I/O, so it can be unit tested with plain arrays. */

/** Averages per-channel Float32Arrays sample-by-sample. Channels arrive as
 * separate arrays from the capture worklet (Web Audio's own per-channel
 * layout) — never interleaved — so there is no interleaved/mono mixup to
 * guard against by construction. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Linear-interpolation resampler. A no-op fast path when rates already
 * match — the common case once the mic's native rate happens to equal the
 * engine's expected rate. Not a high-fidelity resampler (no anti-aliasing
 * filter), which is an accepted, documented tradeoff for a local real-time
 * capture path — see docs/phase4-desktop.md "Known Limitations". */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outputLength = Math.round(input.length * ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcPos = i / ratio;
    const srcIndexLow = Math.floor(srcPos);
    const srcIndexHigh = Math.min(srcIndexLow + 1, input.length - 1);
    const frac = srcPos - srcIndexLow;
    output[i] = input[srcIndexLow] * (1 - frac) + input[srcIndexHigh] * frac;
  }
  return output;
}
