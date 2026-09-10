import { describe, expect, it } from "vitest";
import { ChunkAccumulator } from "@renderer/audio/ChunkAccumulator";

describe("ChunkAccumulator", () => {
  it("emits no chunk until enough samples accumulate", () => {
    const acc = new ChunkAccumulator(500, 1000); // 500 samples per chunk
    const chunks = acc.push(new Float32Array(200));
    expect(chunks).toEqual([]);
  });

  it("emits exactly one chunk of the configured size at the boundary", () => {
    const acc = new ChunkAccumulator(500, 1000); // 500 samples/chunk
    const chunks = acc.push(new Float32Array(500).fill(1));
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(500);
  });

  it("splits a burst larger than one chunk into multiple chunks plus remainder", () => {
    const acc = new ChunkAccumulator(500, 1000); // 500 samples/chunk
    const chunks = acc.push(new Float32Array(1300));
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(500);
    expect(chunks[1].length).toBe(500);
    // 300 samples remain buffered
    const flushed = acc.flush();
    expect(flushed?.length).toBe(300);
  });

  it("carries partial state correctly across multiple push() calls", () => {
    const acc = new ChunkAccumulator(500, 1000);
    expect(acc.push(new Float32Array(300)).length).toBe(0);
    const chunks = acc.push(new Float32Array(300));
    expect(chunks.length).toBe(1);
    const flushed = acc.flush();
    expect(flushed?.length).toBe(100);
  });

  it("flush() returns null when nothing is buffered", () => {
    const acc = new ChunkAccumulator(500, 1000);
    expect(acc.flush()).toBeNull();
  });

  it("flush() clears the buffer so a later push starts fresh", () => {
    const acc = new ChunkAccumulator(500, 1000);
    acc.push(new Float32Array(200));
    acc.flush();
    expect(acc.push(new Float32Array(200)).length).toBe(0);
    expect(acc.flush()?.length).toBe(200);
  });

  it("computes chunk sample count from chunkSizeMs and sampleRate", () => {
    const acc = new ChunkAccumulator(250, 16000); // 4000 samples/chunk
    expect(acc.push(new Float32Array(3999)).length).toBe(0);
    expect(acc.push(new Float32Array(1)).length).toBe(1);
  });

  it("reset() discards buffered samples without returning them", () => {
    const acc = new ChunkAccumulator(500, 1000);
    acc.push(new Float32Array(300));
    acc.reset();
    expect(acc.flush()).toBeNull();
  });
});
