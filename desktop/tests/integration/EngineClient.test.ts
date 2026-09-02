// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient } from "../../src/renderer/src/services/EngineClient";
import { FakeEngineServer } from "./fakeEngineServer";

let server: FakeEngineServer;
let port: number;

beforeEach(async () => {
  server = new FakeEngineServer();
  port = await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe("EngineClient against a real WebSocket (FakeEngineServer)", () => {
  it("connects and validates the protocol version via engine.hello/engine.welcome", async () => {
    const client = new EngineClient(server.url(port));
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.getState()).toBe("connected");
    client.close();
  });

  it("health() returns a real health report round-tripped over the wire", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    const health = await client.health();
    expect(health.state).toBe("READY");
    expect(health.engine).toBe("openvoice_onnx");
    client.close();
  });

  it("loadVoice() resolves with the prepared_voice_id from the server", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    const result = await client.loadVoice("profile-1", ["/tmp/ref0.wav"]);
    expect(result.voice_profile_id).toBe("profile-1");
    expect(result.prepared_voice_id).toBe("fake-prepared-voice-1");
    client.close();
  });

  it("opens a stream, sends audio frames, and receives them back with sequence numbers preserved", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    await client.loadVoice("profile-1", ["/tmp/ref0.wav"]);
    await client.openStream();

    const received: Array<{ sequence: number; samples: number[] }> = [];
    client.onAudioFrame((frame) => received.push({ sequence: frame.sequence, samples: Array.from(frame.samples) }));

    const seq0 = client.sendAudioFrame(22050, new Float32Array([1, 2, 3]));
    const seq1 = client.sendAudioFrame(22050, new Float32Array([4, 5]));
    expect(seq0).toBe(0);
    expect(seq1).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toEqual([
      { sequence: 0, samples: [-1, -2, -3] }, // FakeEngineServer inverts sign deterministically
      { sequence: 1, samples: [-4, -5] },
    ]);
    client.close();
  });

  it("closeStream() resolves with metrics reflecting frames processed", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    await client.loadVoice("profile-1", ["/tmp/ref0.wav"]);
    await client.openStream();
    client.sendAudioFrame(22050, new Float32Array([1]));
    client.sendAudioFrame(22050, new Float32Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = await client.closeStream();
    expect(closed.processed_chunks).toBe(2);
    client.close();
  });

  it("surfaces NO_STREAM_OPEN as a stream error, not a crash, when sending before stream.open", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    const errors: string[] = [];
    client.onStreamError((err) => errors.push(err.code));
    client.sendAudioFrame(22050, new Float32Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual(["NO_STREAM_OPEN"]);
    client.close();
  });

  it("surfaces BACKPRESSURE errors from rejected frames without crashing the client", async () => {
    server.backpressureAfter = 1;
    const client = new EngineClient(server.url(port));
    await client.connect();
    await client.loadVoice("profile-1", ["/tmp/ref0.wav"]);
    await client.openStream();

    const errors: string[] = [];
    const received: number[] = [];
    client.onStreamError((err) => errors.push(err.code));
    client.onAudioFrame((f) => received.push(f.sequence));

    client.sendAudioFrame(22050, new Float32Array([1]));
    client.sendAudioFrame(22050, new Float32Array([1]));
    client.sendAudioFrame(22050, new Float32Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toEqual([0]);
    expect(errors).toEqual(["BACKPRESSURE", "BACKPRESSURE"]);
    client.close();
  });

  it("rejects pending requests cleanly when the connection closes", async () => {
    const client = new EngineClient(server.url(port));
    await client.connect();
    const healthPromise = client.health();
    client.close();
    await expect(healthPromise).rejects.toThrow();
  });
});
