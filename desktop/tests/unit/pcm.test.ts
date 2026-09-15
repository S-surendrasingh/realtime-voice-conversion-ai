import { describe, expect, it } from "vitest";
import { downmixToMono, resampleLinear } from "@renderer/audio/pcm";

describe("downmixToMono", () => {
  it("returns the single channel unchanged for mono input", () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    expect(downmixToMono([mono])).toBe(mono);
  });

  it("averages stereo channels sample-by-sample (never interleaves)", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([-1, 0, 1]);
    expect(Array.from(downmixToMono([left, right]))).toEqual([0, 0, 0]);
  });

  it("averages more than two channels", () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([0, 0]);
    const c = new Float32Array([-1, 2]);
    const result = downmixToMono([a, b, c]);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(1, 5);
  });

  it("returns an empty array for zero channels", () => {
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe("resampleLinear", () => {
  it("is a no-op when rates already match", () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resampleLinear(input, 44100, 44100)).toBe(input);
  });

  it("halves the length when downsampling by 2x", () => {
    const input = new Float32Array(1000).fill(0.5);
    const output = resampleLinear(input, 44100, 22050);
    expect(output.length).toBe(500);
  });

  it("doubles the length when upsampling by 2x", () => {
    const input = new Float32Array(500).fill(0.5);
    const output = resampleLinear(input, 22050, 44100);
    expect(output.length).toBe(1000);
  });

  it("preserves a constant signal's amplitude", () => {
    const input = new Float32Array(100).fill(0.7);
    const output = resampleLinear(input, 48000, 22050);
    for (const sample of output) expect(sample).toBeCloseTo(0.7, 5);
  });

  it("interpolates a linear ramp correctly", () => {
    const input = new Float32Array([0, 1, 2, 3, 4]);
    const output = resampleLinear(input, 4, 8);
    // Upsampling 2x should roughly retrace the same ramp at 2x the points.
    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[output.length - 1]).toBeCloseTo(4, 1);
  });

  it("handles empty input", () => {
    expect(resampleLinear(new Float32Array(0), 44100, 16000).length).toBe(0);
  });
});
