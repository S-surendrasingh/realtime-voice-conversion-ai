/** Accumulates small real-time capture blocks (128-sample AudioWorklet
 * render quanta, already downmixed/resampled) into fixed-duration chunks
 * matching the configured chunk size (250/500/750/1000ms — see
 * PersistedSettings.chunkSizeMs) before handing them to EngineClient. This
 * runs on the main JS thread, NOT inside the AudioWorklet — only the
 * worklet itself needs to stay real-time-safe. */
export class ChunkAccumulator {
  private buffer: Float32Array;
  private filled = 0;
  private readonly chunkSamples: number;

  constructor(chunkSizeMs: number, sampleRate: number) {
    this.chunkSamples = Math.round((chunkSizeMs / 1000) * sampleRate);
    this.buffer = new Float32Array(this.chunkSamples);
  }

  /** Appends new samples; returns zero or more completed chunks (more than
   * one if a burst of input arrives larger than one chunk's worth). */
  push(samples: Float32Array): Float32Array[] {
    const chunks: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const spaceLeft = this.chunkSamples - this.filled;
      const take = Math.min(spaceLeft, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.chunkSamples) {
        chunks.push(this.buffer.slice());
        this.filled = 0;
      }
    }
    return chunks;
  }

  /** Returns the partial trailing chunk (if any) and clears the buffer —
   * used when a stream stops, so the last fraction of speech isn't
   * silently discarded. */
  flush(): Float32Array | null {
    if (this.filled === 0) return null;
    const partial = this.buffer.slice(0, this.filled);
    this.filled = 0;
    return partial;
  }

  reset(): void {
    this.filled = 0;
  }
}
