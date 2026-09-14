import { describe, expect, it, vi } from "vitest";
import { DualOutputAdapter, LocalPlaybackAdapter, VirtualAudioOutputAdapter } from "@renderer/audio/outputAdapter";

class FakeAudioBuffer {
  duration: number;
  private readonly data: Float32Array;
  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  copyToChannel(source: Float32Array): void {
    this.data.set(source);
  }
}

class FakeSourceNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  startAt = 0;
  connect(): void {}
  start(when: number): void {
    this.started = true;
    this.startAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  closed = false;
  createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length, sampleRate);
  }
  createBufferSource(): FakeSourceNode {
    return new FakeSourceNode();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe("LocalPlaybackAdapter", () => {
  it("schedules the first chunk at or after currentTime", () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    ctx.currentTime = 1.5;
    adapter.play(new Float32Array(2205), 22050); // 0.1s
    expect(adapter.getScheduledAheadSeconds()).toBeCloseTo(0.1, 5);
  });

  it("schedules consecutive chunks back-to-back without gap or overlap", () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    adapter.play(new Float32Array(22050), 22050); // 1.0s
    adapter.play(new Float32Array(11025), 22050); // 0.5s
    // Total scheduled ahead should be the sum of both durations, i.e. no
    // gap was introduced and nothing overlapped.
    expect(adapter.getScheduledAheadSeconds()).toBeCloseTo(1.5, 5);
  });

  it("does not schedule before currentTime even if nextPlayTime lags behind", () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    adapter.play(new Float32Array(2205), 22050);
    ctx.currentTime = 100; // time jumped far ahead (e.g. underrun)
    adapter.play(new Float32Array(2205), 22050);
    expect(adapter.getScheduledAheadSeconds()).toBeCloseTo(0.1, 5);
  });

  it("ignores empty chunks without scheduling anything", () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    adapter.play(new Float32Array(0), 22050);
    expect(adapter.getScheduledAheadSeconds()).toBe(0);
  });

  it("close() stops all pending sources and closes the context", () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    adapter.play(new Float32Array(2205), 22050);
    adapter.close();
    expect(ctx.closed).toBe(true);
    expect(adapter.getScheduledAheadSeconds()).toBe(0);
  });

  it("setOutputDevice returns false when setSinkId is unsupported", async () => {
    const ctx = new FakeAudioContext();
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    await expect(adapter.setOutputDevice("some-device")).resolves.toBe(false);
  });

  it("setOutputDevice returns true and calls setSinkId when supported", async () => {
    const ctx = new FakeAudioContext() as FakeAudioContext & { setSinkId?: (id: string) => Promise<void> };
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    ctx.setSinkId = setSinkId;
    const adapter = new LocalPlaybackAdapter(ctx as unknown as AudioContext);
    await expect(adapter.setOutputDevice("device-42")).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith("device-42");
  });
});

describe("VirtualAudioOutputAdapter", () => {
  it("ensureRouted() calls setSinkId with the virtual device id and returns true on success", async () => {
    const ctx = new FakeAudioContext() as FakeAudioContext & { setSinkId?: (id: string) => Promise<void> };
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    ctx.setSinkId = setSinkId;
    const adapter = new VirtualAudioOutputAdapter("cable-input-id", ctx as unknown as AudioContext);
    await expect(adapter.ensureRouted()).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith("cable-input-id");
  });

  it("ensureRouted() returns false when setSinkId is unsupported — Meeting Mode must not silently proceed", async () => {
    const ctx = new FakeAudioContext();
    const adapter = new VirtualAudioOutputAdapter("cable-input-id", ctx as unknown as AudioContext);
    await expect(adapter.ensureRouted()).resolves.toBe(false);
  });

  it("play() reuses the exact same Web Audio scheduling as LocalPlaybackAdapter (no duplicate implementation)", () => {
    const ctx = new FakeAudioContext();
    const adapter = new VirtualAudioOutputAdapter("cable-input-id", ctx as unknown as AudioContext);
    adapter.play(new Float32Array(22050), 22050); // 1.0s
    expect(adapter.getScheduledAheadSeconds()).toBeCloseTo(1.0, 5);
  });

  it("close() tears down its internal LocalPlaybackAdapter", () => {
    const ctx = new FakeAudioContext();
    const adapter = new VirtualAudioOutputAdapter("cable-input-id", ctx as unknown as AudioContext);
    adapter.play(new Float32Array(2205), 22050);
    adapter.close();
    expect(ctx.closed).toBe(true);
    expect(adapter.getScheduledAheadSeconds()).toBe(0);
  });
});

describe("DualOutputAdapter", () => {
  function fakeAdapter() {
    return {
      play: vi.fn(),
      setOutputDevice: vi.fn().mockResolvedValue(true),
      getScheduledAheadSeconds: vi.fn(() => 0),
      close: vi.fn(),
    };
  }

  it("play() forwards the SAME samples to both the primary and monitor adapter — no second conversion pass", () => {
    const primary = fakeAdapter();
    const monitor = fakeAdapter();
    const dual = new DualOutputAdapter(primary, monitor);
    const samples = new Float32Array([1, 2, 3]);
    dual.play(samples, 22050);
    expect(primary.play).toHaveBeenCalledWith(samples, 22050);
    expect(monitor.play).toHaveBeenCalledWith(samples, 22050);
  });

  it("setOutputDevice() only targets the primary (virtual) adapter", async () => {
    const primary = fakeAdapter();
    const monitor = fakeAdapter();
    const dual = new DualOutputAdapter(primary, monitor);
    await dual.setOutputDevice("device-1");
    expect(primary.setOutputDevice).toHaveBeenCalledWith("device-1");
    expect(monitor.setOutputDevice).not.toHaveBeenCalled();
  });

  it("getScheduledAheadSeconds() reports the max of both adapters", () => {
    const primary = fakeAdapter();
    primary.getScheduledAheadSeconds.mockReturnValue(0.3);
    const monitor = fakeAdapter();
    monitor.getScheduledAheadSeconds.mockReturnValue(0.7);
    const dual = new DualOutputAdapter(primary, monitor);
    expect(dual.getScheduledAheadSeconds()).toBe(0.7);
  });

  it("close() closes both adapters", () => {
    const primary = fakeAdapter();
    const monitor = fakeAdapter();
    const dual = new DualOutputAdapter(primary, monitor);
    dual.close();
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(monitor.close).toHaveBeenCalledTimes(1);
  });
});
