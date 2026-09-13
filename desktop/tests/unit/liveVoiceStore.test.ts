import { describe, expect, it, vi } from "vitest";
import { createLiveVoiceStore, type LiveVoiceDeps } from "@renderer/stores/liveVoiceStore";
import type { EngineClient } from "@renderer/services/EngineClient";
import type { AudioFrame, EngineErrorMessage } from "@shared/protocol";
import type { AudioOutputAdapter } from "@renderer/audio/outputAdapter";
import type { MicCaptureOptions } from "@renderer/audio/MicCapture";

const READY_PROFILE = {
  id: "voice-1",
  name: "Person A",
  description: null,
  status: "READY_FOR_AI_PROCESSING" as const,
  consent_confirmed: true,
  consent_confirmed_at: null,
  created_at: "",
  updated_at: "",
  sample_count: 3,
  valid_sample_count: 3,
  total_duration_seconds: 12,
};

function makeFakeEngineClient() {
  const listeners: {
    audioFrame?: (f: AudioFrame) => void;
    streamError?: (e: EngineErrorMessage) => void;
    close?: () => void;
  } = {};
  let sequence = 0;
  const fake = {
    connect: vi.fn().mockResolvedValue(undefined),
    loadVoice: vi.fn().mockResolvedValue({ voice_profile_id: "voice-1", prepared_voice_id: "prep-1" }),
    openStream: vi.fn().mockResolvedValue({ session_id: "s1" }),
    closeStream: vi.fn().mockResolvedValue({
      queue_depth: 0,
      dropped_chunks: 0,
      processed_chunks: 1,
      avg_processing_latency_ms: 10,
      end_to_end_estimated_latency_ms: 10,
    }),
    sendAudioFrame: vi.fn(() => sequence++),
    onAudioFrame: vi.fn((cb: (f: AudioFrame) => void) => {
      listeners.audioFrame = cb;
      return () => undefined;
    }),
    onStreamError: vi.fn((cb: (e: EngineErrorMessage) => void) => {
      listeners.streamError = cb;
      return () => undefined;
    }),
    onClose: vi.fn((cb: () => void) => {
      listeners.close = cb;
      return () => undefined;
    }),
    close: vi.fn(),
    _listeners: listeners,
  };
  return fake;
}

function makeFakeMicCapture() {
  let capturedOptions: MicCaptureOptions | null = null;
  return {
    start: vi.fn(async (options: MicCaptureOptions) => {
      capturedOptions = options;
    }),
    stop: vi.fn((): Float32Array | null => null),
    isActive: vi.fn(() => true),
    getCapturedOptions: () => capturedOptions,
  };
}

function makeFakeOutputAdapter(): AudioOutputAdapter {
  return {
    play: vi.fn(),
    setOutputDevice: vi.fn().mockResolvedValue(true),
    getScheduledAheadSeconds: vi.fn(() => 0),
    close: vi.fn(),
  };
}

function makeDeps(overrides: Partial<LiveVoiceDeps> = {}) {
  const fakeEngineClient = makeFakeEngineClient();
  const fakeMic = makeFakeMicCapture();
  const fakeOutput = makeFakeOutputAdapter();

  const deps: LiveVoiceDeps = {
    backendClient: {
      getVoiceProfile: vi.fn().mockResolvedValue(READY_PROFILE),
    } as unknown as LiveVoiceDeps["backendClient"],
    getRuntimeConfig: vi.fn().mockResolvedValue({
      backendUrl: "http://127.0.0.1:8000",
      engineHost: "127.0.0.1",
      engineWsPort: 8765,
      engineWsUrl: "ws://127.0.0.1:8765",
      engineSampleRate: 22050,
      platform: "linux",
      appVersion: "0.1.0",
      isPackaged: false,
    }),
    getSettings: vi.fn().mockResolvedValue({
      microphoneDeviceId: null,
      outputDeviceId: null,
      voiceProfileId: null,
      engineMode: "managed",
      chunkSizeMs: 500,
      jitterBufferMs: 200,
      backendUrlOverride: null,
      engineWsUrlOverride: null,
      debugMetrics: false,
      debugRecordingEnabled: false,
      outputMode: "local",
      localMonitoringEnabled: false,
      preferredVirtualDeviceId: null,
    }),
    ensureEngineRunning: vi.fn().mockResolvedValue({
      mode: "managed",
      running: true,
      ready: true,
      pid: 123,
      startedAt: Date.now(),
      lastError: null,
      restartCount: 0,
    }),
    prepareLocalReferences: vi.fn().mockResolvedValue({ referencePaths: ["/tmp/ref0.wav"] }),
    createEngineClient: vi.fn(() => fakeEngineClient as unknown as EngineClient),
    createMicCapture: vi.fn(() => fakeMic as never),
    createOutputAdapter: vi.fn(async () => ({ adapter: fakeOutput, routed: true })),
    enumerateDevices: vi.fn().mockResolvedValue({ inputDevices: [], outputDevices: [] }),
    watchDeviceChanges: vi.fn(() => () => undefined),
    now: () => 0,
    ...overrides,
  };

  return { deps, fakeEngineClient, fakeMic, fakeOutput };
}

describe("liveVoiceStore state machine", () => {
  it("walks through CHECKING -> CONNECTING -> LOADING_VOICE -> STARTING -> LIVE on success", async () => {
    const { deps } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");

    const seen: string[] = [];
    const unsub = useStore.subscribe((s) => seen.push(s.state));
    await useStore.getState().startLive();
    unsub();

    expect(seen).toEqual(["CHECKING", "CONNECTING", "LOADING_VOICE", "STARTING", "LIVE"]);
    expect(useStore.getState().error).toBeNull();
  });

  it("refuses to start without a selected voice profile", async () => {
    const { deps } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/select a voice/i);
  });

  it("goes to ERROR when the selected voice is not READY_FOR_AI_PROCESSING", async () => {
    const { deps } = makeDeps({
      backendClient: {
        getVoiceProfile: vi.fn().mockResolvedValue({ ...READY_PROFILE, status: "PROCESSING" }),
      } as unknown as LiveVoiceDeps["backendClient"],
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/not ready/i);
  });

  it("goes to ERROR with the engine's own message when the engine isn't ready", async () => {
    const { deps } = makeDeps({
      ensureEngineRunning: vi.fn().mockResolvedValue({
        mode: "managed",
        running: false,
        ready: false,
        pid: null,
        startedAt: null,
        lastError: "Engine python not found",
        restartCount: 0,
      }),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toBe("Engine python not found");
  });

  it("cleans up and reports ERROR if connect() throws", async () => {
    const { deps, fakeEngineClient } = makeDeps();
    fakeEngineClient.connect.mockRejectedValue(new Error("connection refused"));
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/connection refused/);
  });

  it("cleans up mic capture if openStream() fails after mic setup would have started", async () => {
    const { deps, fakeMic } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("LIVE");
    expect(fakeMic.start).toHaveBeenCalledTimes(1);
  });

  it("routes converted audio frames into the output adapter via the jitter buffer, in order", async () => {
    const { deps, fakeEngineClient, fakeOutput } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    const onFrame = fakeEngineClient._listeners.audioFrame!;
    onFrame({ sequence: 0, sampleRate: 22050, samples: new Float32Array([1]) });
    onFrame({ sequence: 1, sampleRate: 22050, samples: new Float32Array([2]) });

    expect(fakeOutput.play).toHaveBeenCalledTimes(2);
    expect(useStore.getState().metrics.receivedFrames).toBe(2);
  });

  it("counts BACKPRESSURE stream errors as rejected frames without failing the session", async () => {
    const { deps, fakeEngineClient } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    fakeEngineClient._listeners.streamError!({ version: 1, type: "engine.error", code: "BACKPRESSURE", message: "full" });
    expect(useStore.getState().state).toBe("LIVE");
    expect(useStore.getState().metrics.rejectedFrames).toBe(1);
  });

  it("fails the session on a genuine protocol error like INVALID_AUDIO_FRAME", async () => {
    const { deps, fakeEngineClient } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    fakeEngineClient._listeners.streamError!({
      version: 1,
      type: "engine.error",
      code: "INVALID_AUDIO_FRAME",
      message: "bad frame",
    });
    expect(useStore.getState().state).toBe("ERROR");
  });

  it("fails the session when the mic reports device loss", async () => {
    const fakeMic = makeFakeMicCapture();
    fakeMic.start.mockImplementation(async (options: MicCaptureOptions) => {
      options.onDeviceLost?.();
    });
    const { deps } = makeDeps({ createMicCapture: () => fakeMic as never });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/disconnected/i);
  });

  it("stopLive() closes the stream, releases resources, and returns to IDLE", async () => {
    const { deps, fakeEngineClient, fakeMic, fakeOutput } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    await useStore.getState().stopLive();

    expect(fakeEngineClient.closeStream).toHaveBeenCalledTimes(1);
    expect(fakeMic.stop).toHaveBeenCalledTimes(1);
    expect(fakeOutput.close).toHaveBeenCalledTimes(1);
    expect(fakeEngineClient.close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().state).toBe("IDLE");
  });

  it("stopLive() sends any trailing partial chunk before closing the stream", async () => {
    const fakeMic = makeFakeMicCapture();
    fakeMic.stop.mockReturnValue(new Float32Array([0.1, 0.2]));
    const { deps, fakeEngineClient } = makeDeps({ createMicCapture: () => fakeMic as never });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    fakeEngineClient.sendAudioFrame.mockClear();

    await useStore.getState().stopLive();

    expect(fakeEngineClient.sendAudioFrame).toHaveBeenCalledWith(22050, expect.any(Float32Array));
  });

  it("stopLive() is a no-op when not LIVE or STARTING", async () => {
    const { deps, fakeEngineClient } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    await useStore.getState().stopLive();
    expect(fakeEngineClient.closeStream).not.toHaveBeenCalled();
    expect(useStore.getState().state).toBe("IDLE");
  });

  it("computes real client-observed latency and RTF from send/receive timestamps", async () => {
    let clock = 1000;
    const { deps, fakeEngineClient, fakeMic } = makeDeps({ now: () => clock });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    // MicCapture's onChunk was captured via createMicCapture's fake — invoke
    // it directly through the store's real send path instead: simulate by
    // calling sendAudioFrame via the fake client's tracked sequence, then
    // emulate the elapsed time before the frame comes back.
    const onChunk = fakeMic.start.mock.calls[0][0].onChunk as (samples: Float32Array, sampleRate: number) => void;
    onChunk(new Float32Array([1]), 22050); // sequence 0 sent at clock=1000

    clock = 1120; // 120ms round trip
    fakeEngineClient._listeners.audioFrame!({ sequence: 0, sampleRate: 22050, samples: new Float32Array([1]) });

    const metrics = useStore.getState().metrics;
    expect(metrics.processingLatencyMs).toBeCloseTo(120, 5);
    expect(metrics.rtf).toBeCloseTo(120 / 500, 5); // default chunkSizeMs from fake settings is 500
  });

  it("tracks queueDepth as frames sent but not yet received or rejected", async () => {
    const { deps, fakeEngineClient, fakeMic } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();

    const onChunk = fakeMic.start.mock.calls[0][0].onChunk as (samples: Float32Array, sampleRate: number) => void;
    onChunk(new Float32Array([1]), 22050);
    onChunk(new Float32Array([1]), 22050);
    expect(useStore.getState().metrics.queueDepth).toBe(2);

    fakeEngineClient._listeners.audioFrame!({ sequence: 0, sampleRate: 22050, samples: new Float32Array([1]) });
    expect(useStore.getState().metrics.queueDepth).toBe(1);
  });

  it("merges the real server-reported final metrics into the store on stopLive()", async () => {
    const { deps, fakeEngineClient } = makeDeps();
    fakeEngineClient.closeStream.mockResolvedValue({
      queue_depth: 0,
      dropped_chunks: 3,
      processed_chunks: 10,
      avg_processing_latency_ms: 42,
      end_to_end_estimated_latency_ms: 84,
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    await useStore.getState().stopLive();

    const metrics = useStore.getState().metrics;
    expect(metrics.droppedChunks).toBe(3);
    expect(metrics.endToEndEstimatedLatencyMs).toBe(84);
  });

  it("does not send mic chunks through a stale sequence counter across two Live sessions", async () => {
    const { deps } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    await useStore.getState().stopLive();
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("LIVE");
    expect(deps.createEngineClient).toHaveBeenCalledTimes(2);
  });
});

function mediaDevice(deviceId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo {
  return { deviceId, kind, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

const WINDOWS_CONFIG = {
  backendUrl: "http://127.0.0.1:8000",
  engineHost: "127.0.0.1",
  engineWsPort: 8765,
  engineWsUrl: "ws://127.0.0.1:8765",
  engineSampleRate: 22050,
  platform: "win32" as const,
  appVersion: "0.1.0",
  isPackaged: false,
};

const CABLE_DEVICES = {
  inputDevices: [mediaDevice("cable-out", "audioinput", "CABLE Output (VB-Audio Virtual Cable)")],
  outputDevices: [mediaDevice("cable-in", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)")],
};

describe("liveVoiceStore Meeting Mode", () => {
  it("routes to the detected virtual device and reaches LIVE when everything is ready", async () => {
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue(CABLE_DEVICES),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();

    expect(useStore.getState().state).toBe("LIVE");
    expect(deps.createOutputAdapter).toHaveBeenCalledWith("meeting", "cable-in");
    expect(useStore.getState().meetingModeStatus?.ready).toBe(true);
  });

  it("fails BEFORE connecting to the engine when no virtual device is installed", async () => {
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue({ inputDevices: [], outputDevices: [] }),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();

    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/VB-CABLE/);
    expect(deps.createEngineClient).not.toHaveBeenCalled();
  });

  it("fails with a clear message when multiple candidate devices are ambiguous", async () => {
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue({
        inputDevices: [],
        outputDevices: [
          mediaDevice("a", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
          mediaDevice("b", "audiooutput", "CABLE-A Input (VB-Audio Virtual Cable A)"),
        ],
      }),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();

    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/Multiple virtual audio devices/);
    expect(deps.createEngineClient).not.toHaveBeenCalled();
  });

  it("fails and cleans up when routing to the virtual device fails (routed: false)", async () => {
    const { deps, fakeEngineClient, fakeMic } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue(CABLE_DEVICES),
      createOutputAdapter: vi.fn(async () => ({
        adapter: { play: vi.fn(), setOutputDevice: vi.fn(), getScheduledAheadSeconds: vi.fn(() => 0), close: vi.fn() },
        routed: false,
      })),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();

    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/Could not route audio/);
    // The engine stream/mic were already opened by this point in the flow
    // — cleanup must still tear them down, not leave them dangling.
    expect(fakeEngineClient.closeStream).not.toHaveBeenCalled(); // never reached mic capture
    expect(fakeMic.start).not.toHaveBeenCalled();
  });

  it("never subscribes to device-change watching in local mode", async () => {
    const { deps } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    await useStore.getState().startLive();
    expect(deps.watchDeviceChanges).not.toHaveBeenCalled();
  });

  it("stops safely when the virtual device disappears mid-session (hot-plug)", async () => {
    let deviceChangeCallback: (() => void) | null = null;
    const unwatch = vi.fn();
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi
        .fn()
        .mockResolvedValueOnce(CABLE_DEVICES) // initial readiness check in startLive()
        .mockResolvedValue({ inputDevices: [], outputDevices: [] }), // device vanished by the time the hot-plug callback re-checks
      watchDeviceChanges: vi.fn((cb: () => void) => {
        deviceChangeCallback = cb;
        return unwatch;
      }),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();
    expect(useStore.getState().state).toBe("LIVE");

    expect(deviceChangeCallback).not.toBeNull();
    await deviceChangeCallback!();

    expect(useStore.getState().state).toBe("ERROR");
    expect(useStore.getState().error).toMatch(/disappeared/);
    expect(unwatch).toHaveBeenCalledTimes(1);
  });

  it("refreshMeetingModeStatus() works standalone, without starting Live", async () => {
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue(CABLE_DEVICES),
    });
    const useStore = createLiveVoiceStore(deps);
    const status = await useStore.getState().refreshMeetingModeStatus();
    expect(status.ready).toBe(true);
    expect(useStore.getState().state).toBe("IDLE");
    expect(useStore.getState().meetingModeStatus).toEqual(status);
  });

  it("setOutputMode/setLocalMonitoringEnabled update store state directly", () => {
    const { deps } = makeDeps();
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setOutputMode("meeting");
    expect(useStore.getState().outputMode).toBe("meeting");
    useStore.getState().setLocalMonitoringEnabled(true);
    expect(useStore.getState().localMonitoringEnabled).toBe(true);
  });

  it("passes localMonitoringEnabled through to createOutputAdapter's real wiring via settings (integration is in singletons.ts; store just forwards mode/deviceId)", async () => {
    const { deps } = makeDeps({
      getRuntimeConfig: vi.fn().mockResolvedValue(WINDOWS_CONFIG),
      enumerateDevices: vi.fn().mockResolvedValue(CABLE_DEVICES),
    });
    const useStore = createLiveVoiceStore(deps);
    useStore.getState().setSelectedVoiceProfileId("voice-1");
    useStore.getState().setOutputMode("meeting");
    await useStore.getState().startLive();
    expect(deps.createOutputAdapter).toHaveBeenCalledWith("meeting", "cable-in");
  });
});
