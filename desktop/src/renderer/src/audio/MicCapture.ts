import { ChunkAccumulator } from "./ChunkAccumulator";
import { downmixToMono, resampleLinear } from "./pcm";

export interface MicCaptureOptions {
  deviceId?: string;
  /** The resident engine's expected input sample rate — inspected from the
   * real running contract, never guessed (see docs/phase4-desktop.md
   * "Microphone Pipeline"). */
  targetSampleRate: number;
  chunkSizeMs: number;
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  /** Raw per-block RMS level (0..1), for the input level meter. Called at
   * worklet block rate — throttle in the UI layer, not here. */
  onLevel?: (rms: number) => void;
  /** Fired when the underlying microphone track ends unexpectedly (device
   * unplugged, permission revoked mid-session, etc.) — the caller must
   * treat this the same as an explicit stop, never keep showing LIVE. */
  onDeviceLost?: () => void;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const s of samples) sumSquares += s * s;
  return Math.sqrt(sumSquares / samples.length);
}

/** Owns the getUserMedia -> AudioContext -> AudioWorklet -> mono downmix ->
 * resample -> chunk-accumulate pipeline (Step 16-21). The AudioWorklet
 * itself (capture-processor.js) does only real-time-safe copying; all of
 * downmix/resample/chunking runs here, on the regular JS thread. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private accumulator: ChunkAccumulator | null = null;

  async start(options: MicCaptureOptions): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const track = this.stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => options.onDeviceLost?.());

    this.audioContext = new AudioContext();
    await this.audioContext.audioWorklet.addModule(new URL("./capture-processor.js", import.meta.url));

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, "voiceshift-capture-processor");
    this.accumulator = new ChunkAccumulator(options.chunkSizeMs, options.targetSampleRate);

    this.workletNode.port.onmessage = (event: MessageEvent<{ channels: Float32Array[]; sampleRate: number }>) => {
      const { channels, sampleRate } = event.data;
      const mono = downmixToMono(channels);
      options.onLevel?.(rms(mono));
      const resampled = resampleLinear(mono, sampleRate, options.targetSampleRate);
      const chunks = this.accumulator!.push(resampled);
      for (const chunk of chunks) options.onChunk(chunk, options.targetSampleRate);
    };

    // Intentionally NOT connected to audioContext.destination — Person B
    // must not hear their own raw mic input looped back (that would add a
    // second, non-AI feedback path on top of the converted-audio one; see
    // Step 27 headphone warning).
    this.sourceNode.connect(this.workletNode);
  }

  /** Stops capture and returns any trailing partial chunk so the last
   * fraction of speech isn't silently discarded. */
  stop(): Float32Array | null {
    this.workletNode?.port.close();
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const partial = this.accumulator?.flush() ?? null;
    this.audioContext?.close().catch(() => undefined);

    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.accumulator = null;
    return partial;
  }

  isActive(): boolean {
    return this.stream !== null;
  }
}
