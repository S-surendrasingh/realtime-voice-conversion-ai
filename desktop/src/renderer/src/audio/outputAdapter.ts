/** Output-side abstraction (Step 28). Only LocalPlaybackAdapter is
 * implemented in Phase 4. Future WindowsVirtualAudioAdapter (VB-CABLE) and
 * MacVirtualAudioAdapter (BlackHole) implement the same interface so
 * Phase 5 can add them without touching mic capture, EngineClient, or the
 * live state machine — callers only ever depend on AudioOutputAdapter. */
export interface AudioOutputAdapter {
  /** Schedules one chunk of mono float32 PCM at `sampleRate` for playback
   * as soon as the adapter's internal schedule allows (immediately after
   * whatever it most recently scheduled, never overlapping). */
  play(samples: Float32Array, sampleRate: number): void;
  /** Best-effort: select a specific output device, if the platform/adapter
   * supports it. Returns false if unsupported rather than throwing. */
  setOutputDevice(deviceId: string): Promise<boolean>;
  /** Seconds of audio currently scheduled but not yet played — useful for
   * surfacing playback buffer depth in the UI. */
  getScheduledAheadSeconds(): number;
  close(): void;
}

/** Continuous low-latency playback via Web Audio API scheduling — never
 * one HTMLAudioElement per chunk. Tracks a `nextPlayTime` cursor so
 * consecutive chunks queue back-to-back with no gap and no overlap. */
export class LocalPlaybackAdapter implements AudioOutputAdapter {
  private readonly context: AudioContext;
  private nextPlayTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext();
  }

  play(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    // decodeAudioFrame always backs `samples` with a plain ArrayBuffer (see
    // src/shared/protocol.ts) — this cast only narrows TS's overly generic
    // ArrayBufferLike inference, it doesn't change runtime behavior.
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    const contextWithSink = this.context as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof contextWithSink.setSinkId !== "function") return false;
    try {
      await contextWithSink.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  getScheduledAheadSeconds(): number {
    return Math.max(0, this.nextPlayTime - this.context.currentTime);
  }

  close(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped/ended */
      }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
    this.context.close().catch(() => undefined);
  }
}

/** Meeting Mode's output adapter (Phase 5). A "virtual audio device" like
 * VB-CABLE's "CABLE Input" or macOS's "BlackHole 2ch" is, from Web Audio's
 * perspective, just an ordinary audio OUTPUT device — `AudioContext`
 * doesn't distinguish it from a real speaker. There is deliberately no
 * separate playback/scheduling implementation here: this wraps a real
 * `LocalPlaybackAdapter` and only adds the explicit "route to this
 * specific virtual device, and know whether that actually worked" step
 * Meeting Mode's readiness gate needs (see stores/liveVoiceStore.ts) —
 * exactly the "don't create an unnecessary native addon" guidance this
 * followed, per docs/phase5-virtual-audio.md. */
export class VirtualAudioOutputAdapter implements AudioOutputAdapter {
  private readonly local: LocalPlaybackAdapter;

  constructor(
    private readonly virtualDeviceId: string,
    context?: AudioContext
  ) {
    this.local = new LocalPlaybackAdapter(context);
  }

  /** Must be awaited before any play() calls are expected to actually
   * reach the virtual device. Returns false if setSinkId is unsupported or
   * the device rejected selection — Meeting Mode must treat that as NOT
   * ready, never silently fall back to the default output (Step 21). */
  ensureRouted(): Promise<boolean> {
    return this.local.setOutputDevice(this.virtualDeviceId);
  }

  play(samples: Float32Array, sampleRate: number): void {
    this.local.play(samples, sampleRate);
  }

  setOutputDevice(deviceId: string): Promise<boolean> {
    return this.local.setOutputDevice(deviceId);
  }

  getScheduledAheadSeconds(): number {
    return this.local.getScheduledAheadSeconds();
  }

  close(): void {
    this.local.close();
  }
}

/** Optional local monitoring while in Meeting Mode (Step 29/30) — fans the
 * SAME already-converted PCM out to two adapters. Never a second AI/
 * conversion pass: both `play()` calls receive the identical samples this
 * class was given, and LocalPlaybackAdapter.play() copies into its own
 * AudioBuffer, so sharing one Float32Array between both targets is safe. */
export class DualOutputAdapter implements AudioOutputAdapter {
  constructor(
    private readonly primary: AudioOutputAdapter,
    private readonly monitor: AudioOutputAdapter
  ) {}

  play(samples: Float32Array, sampleRate: number): void {
    this.primary.play(samples, sampleRate);
    this.monitor.play(samples, sampleRate);
  }

  setOutputDevice(deviceId: string): Promise<boolean> {
    return this.primary.setOutputDevice(deviceId);
  }

  getScheduledAheadSeconds(): number {
    return Math.max(this.primary.getScheduledAheadSeconds(), this.monitor.getScheduledAheadSeconds());
  }

  close(): void {
    this.primary.close();
    this.monitor.close();
  }
}
