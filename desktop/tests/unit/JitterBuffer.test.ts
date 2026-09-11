import { describe, expect, it, vi } from "vitest";
import { JitterBuffer } from "@renderer/audio/JitterBuffer";
import type { AudioFrame } from "@shared/protocol";

function frame(sequence: number): AudioFrame {
  return { sequence, sampleRate: 22050, samples: new Float32Array([sequence]) };
}

describe("JitterBuffer", () => {
  it("releases in-order frames immediately, in order", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(0));
    buf.push(frame(1));
    buf.push(frame(2));
    expect(released).toEqual([0, 1, 2]);
  });

  it("holds an out-of-order frame until the gap fills, then releases in order", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(0));
    buf.push(frame(2)); // arrives early — held
    expect(released).toEqual([0]);
    buf.push(frame(1)); // fills the gap
    expect(released).toEqual([0, 1, 2]);
  });

  it("drops an exact duplicate of an already-held or already-released sequence", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(0));
    buf.push(frame(0)); // duplicate of already-released
    buf.push(frame(2));
    buf.push(frame(2)); // duplicate of held frame
    expect(released).toEqual([0]);
    expect(buf.getStats().duplicatesDropped).toBe(1);
    expect(buf.getStats().lateDropped).toBe(1);
  });

  it("drops a late frame that arrives after its sequence already passed", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(0));
    buf.push(frame(1));
    buf.push(frame(0)); // late
    expect(released).toEqual([0, 1]);
    expect(buf.getStats().lateDropped).toBe(1);
  });

  it("skips a missing sequence after maxHoldMs so playback never stalls forever", () => {
    let simulatedNow = 1000;
    const released: number[] = [];
    const buf = new JitterBuffer(100, (f) => released.push(f.sequence), () => simulatedNow);
    buf.push(frame(0));
    buf.push(frame(2)); // sequence 1 never arrives
    expect(released).toEqual([0]);

    buf.tick(); // starts the wait clock
    simulatedNow += 150; // exceed maxHoldMs
    buf.tick(); // should skip sequence 1 and release 2

    expect(released).toEqual([0, 2]);
    expect(buf.getStats().skippedMissing).toBe(1);
  });

  it("does not skip prematurely before maxHoldMs elapses", () => {
    let simulatedNow = 1000;
    const released: number[] = [];
    const buf = new JitterBuffer(100, (f) => released.push(f.sequence), () => simulatedNow);
    buf.push(frame(0));
    buf.push(frame(2));
    buf.tick();
    simulatedNow += 50; // under maxHoldMs
    buf.tick();
    expect(released).toEqual([0]);
  });

  it("tracks the highest sequence seen even while frames are held", () => {
    const buf = new JitterBuffer(200, vi.fn());
    buf.push(frame(0));
    buf.push(frame(5));
    expect(buf.getStats().highestSequenceSeen).toBe(5);
  });

  it("starts numbering from the first frame's sequence, not always 0", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(10));
    buf.push(frame(11));
    expect(released).toEqual([10, 11]);
  });

  it("reset() clears held frames and restarts sequence tracking", () => {
    const released: number[] = [];
    const buf = new JitterBuffer(200, (f) => released.push(f.sequence));
    buf.push(frame(0));
    buf.push(frame(2));
    buf.reset();
    buf.push(frame(50));
    expect(released).toEqual([0, 50]);
  });
});
