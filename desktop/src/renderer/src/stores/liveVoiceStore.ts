import { create } from "zustand";
import type { AudioFrame, EngineErrorMessage } from "@shared/protocol";
import type { OutputMode, PersistedSettings, RuntimeConfig, EngineProcessStatus } from "@shared/types";
import type { VirtualDeviceStatus } from "@shared/virtualAudio";
import type { BackendClient } from "../services/BackendClient";
import type { EngineClient } from "../services/EngineClient";
import { JitterBuffer } from "../audio/JitterBuffer";
import { MicCapture } from "../audio/MicCapture";
import type { AudioOutputAdapter } from "../audio/outputAdapter";
import { getVirtualAudioIntegration } from "../audio/virtualAudioAdapters";

export type LiveVoiceState =
  | "IDLE"
  | "CHECKING"
  | "CONNECTING"
  | "LOADING_VOICE"
  | "READY"
  | "STARTING"
  | "LIVE"
  | "STOPPING"
  | "ERROR";

export interface LiveVoiceMetrics {
  rtf: number | null;
  processingLatencyMs: number | null;
  endToEndEstimatedLatencyMs: number | null;
  queueDepth: number;
  droppedChunks: number;
  rejectedFrames: number;
  sentFrames: number;
  receivedFrames: number;
  inputLevel: number;
  outputLevel: number;
  sessionDurationSec: number;
}

const INITIAL_METRICS: LiveVoiceMetrics = {
  rtf: null,
  processingLatencyMs: null,
  endToEndEstimatedLatencyMs: null,
  queueDepth: 0,
  droppedChunks: 0,
  rejectedFrames: 0,
  sentFrames: 0,
  receivedFrames: 0,
  inputLevel: 0,
  outputLevel: 0,
  sessionDurationSec: 0,
};

interface DeviceLists {
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
}

/** Everything the store needs from the outside world, injected so tests
 * can supply fakes without touching real browser audio APIs, real
 * WebSockets, or real IPC. */
export interface LiveVoiceDeps {
  backendClient: Pick<BackendClient, "getVoiceProfile">;
  getRuntimeConfig: () => Promise<RuntimeConfig>;
  getSettings: () => Promise<PersistedSettings>;
  ensureEngineRunning: () => Promise<EngineProcessStatus>;
  prepareLocalReferences: (voiceProfileId: string) => Promise<{ referencePaths: string[] }>;
  createEngineClient: (url: string) => EngineClient;
  createMicCapture: () => MicCapture;
  /** Constructs whichever concrete AudioOutputAdapter this output mode
   * needs and, for "meeting" mode, resolves/validates routing to the
   * virtual device — a single async factory so the store never needs to
   * know about LocalPlaybackAdapter/VirtualAudioOutputAdapter/
   * DualOutputAdapter concretely (see services/singletons.ts for the real
   * wiring). `routed` is always true for "local" mode; for "meeting" mode
   * it reflects whether setSinkId actually succeeded. */
  createOutputAdapter: (mode: OutputMode, virtualDeviceId: string | null) => Promise<{ adapter: AudioOutputAdapter; routed: boolean }>;
  enumerateDevices: () => Promise<DeviceLists>;
  /** Wires to navigator.mediaDevices' devicechange event in production;
   * fakeable in tests. Returns an unsubscribe function. */
  watchDeviceChanges: (callback: () => void) => () => void;
  /** Wall-clock now, injectable for deterministic tests. */
  now?: () => number;
}

export interface LiveVoiceStore {
  state: LiveVoiceState;
  error: string | null;
  metrics: LiveVoiceMetrics;
  selectedVoiceProfileId: string | null;
  selectedMicDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  outputMode: OutputMode;
  localMonitoringEnabled: boolean;
  /** Last-known virtual-device status — refreshable independent of LIVE
   * state (System Check / Audio Devices call refreshMeetingModeStatus()
   * directly) and always re-validated as part of Start Live's readiness
   * gate when outputMode is "meeting". Never implies Meeting Mode is
   * ready just because the AI engine is ready (Step 17). */
  meetingModeStatus: VirtualDeviceStatus | null;
  setSelectedVoiceProfileId: (id: string | null) => void;
  setSelectedMicDeviceId: (id: string | null) => void;
  setSelectedOutputDeviceId: (id: string | null) => void;
  setOutputMode: (mode: OutputMode) => void;
  setLocalMonitoringEnabled: (enabled: boolean) => void;
  refreshMeetingModeStatus: () => Promise<VirtualDeviceStatus>;
  startLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  /** Records a short sample, converts it, and plays it back — reuses the
   * exact same pipeline as Live (Step 32), just without leaving the mic
   * capturing indefinitely. */
  testVoice: (durationMs?: number) => Promise<void>;
}

const METRICS_TICK_MS = 150; // ~6-7 Hz UI updates — within the 4-10Hz target

export function createLiveVoiceStore(deps: LiveVoiceDeps) {
  const now = deps.now ?? (() => Date.now());

  let engineClient: EngineClient | null = null;
  let micCapture: MicCapture | null = null;
  let outputAdapter: AudioOutputAdapter | null = null;
  let jitterBuffer: JitterBuffer | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let unwatchDevices: (() => void) | null = null;
  let sessionStartedAt: number | null = null;
  let engineSampleRate = 22050;
  let chunkDurationMs = 500;
  let lastReceivedRms = 0;
  // Maps an outgoing frame's sequence number to the time it was sent, so
  // that when the SAME sequence comes back converted (see EngineClient's
  // sendAudioFrame doc comment), the elapsed time is a real, client-observed
  // "capture -> converted frame received" latency (Step 41) — not the
  // engine's own internal-only inference timer, which this process cannot
  // see except at stream.close (see stopLive()).
  const sentAt = new Map<number, number>();
  const recentLatenciesMs: number[] = [];
  const MAX_LATENCY_SAMPLES = 20;
  // Bumped by fail()/stopLive() so an in-flight startLive() can detect that
  // something else already ended this session (e.g. onDeviceLost firing
  // mid-await) and must not clobber ERROR/IDLE back to LIVE afterwards.
  let sessionEpoch = 0;

  const useStore = create<LiveVoiceStore>((set, get) => {
    function updateMetrics(patch: Partial<LiveVoiceMetrics>): void {
      set((s) => ({ metrics: { ...s.metrics, ...patch } }));
    }

    function cleanupResources(): void {
      if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
      }
      if (unwatchDevices) {
        unwatchDevices();
        unwatchDevices = null;
      }
      micCapture?.stop();
      micCapture = null;
      outputAdapter?.close();
      outputAdapter = null;
      jitterBuffer = null;
      engineClient?.close();
      engineClient = null;
      sessionStartedAt = null;
      sentAt.clear();
      recentLatenciesMs.length = 0;
    }

    function fail(message: string): void {
      sessionEpoch += 1;
      cleanupResources();
      set({ state: "ERROR", error: message });
    }

    async function resolveMeetingModeStatus(preferredVirtualDeviceId: string | null): Promise<VirtualDeviceStatus> {
      const config = await deps.getRuntimeConfig();
      const { inputDevices, outputDevices } = await deps.enumerateDevices();
      const status = getVirtualAudioIntegration(config.platform).getStatus(
        inputDevices,
        outputDevices,
        preferredVirtualDeviceId
      );
      set({ meetingModeStatus: status });
      return status;
    }

    function onEngineAudioFrame(frame: AudioFrame): void {
      let rms = 0;
      for (const s of frame.samples) rms += s * s;
      lastReceivedRms = frame.samples.length > 0 ? Math.sqrt(rms / frame.samples.length) : lastReceivedRms;
      jitterBuffer?.push(frame);

      const sentTimestamp = sentAt.get(frame.sequence);
      let latencyPatch: Partial<LiveVoiceMetrics> = {};
      if (sentTimestamp !== undefined) {
        sentAt.delete(frame.sequence);
        const latencyMs = now() - sentTimestamp;
        recentLatenciesMs.push(latencyMs);
        if (recentLatenciesMs.length > MAX_LATENCY_SAMPLES) recentLatenciesMs.shift();
        const avgLatencyMs = recentLatenciesMs.reduce((a, b) => a + b, 0) / recentLatenciesMs.length;
        latencyPatch = {
          processingLatencyMs: avgLatencyMs,
          rtf: chunkDurationMs > 0 ? avgLatencyMs / chunkDurationMs : null,
        };
      }

      set((s) => ({
        metrics: {
          ...s.metrics,
          ...latencyPatch,
          receivedFrames: s.metrics.receivedFrames + 1,
          queueDepth: Math.max(0, s.metrics.sentFrames - (s.metrics.receivedFrames + 1) - s.metrics.rejectedFrames),
        },
      }));
    }

    function onEngineStreamError(err: EngineErrorMessage): void {
      if (err.code === "BACKPRESSURE" || err.code === "CONVERSION_FAILED") {
        set((s) => {
          const rejectedFrames = s.metrics.rejectedFrames + 1;
          return {
            metrics: {
              ...s.metrics,
              rejectedFrames,
              queueDepth: Math.max(0, s.metrics.sentFrames - s.metrics.receivedFrames - rejectedFrames),
            },
          };
        });
        return;
      }
      // NO_STREAM_OPEN / INVALID_AUDIO_FRAME while LIVE indicate a real
      // protocol-level problem, not routine backpressure — surface as an
      // error rather than silently counting it.
      fail(`Engine reported an error: ${err.code} — ${err.message}`);
    }

    return {
      state: "IDLE",
      error: null,
      metrics: INITIAL_METRICS,
      selectedVoiceProfileId: null,
      selectedMicDeviceId: null,
      selectedOutputDeviceId: null,
      outputMode: "local",
      localMonitoringEnabled: false,
      meetingModeStatus: null,

      setSelectedVoiceProfileId: (id) => set({ selectedVoiceProfileId: id }),
      setSelectedMicDeviceId: (id) => set({ selectedMicDeviceId: id }),
      setSelectedOutputDeviceId: (id) => set({ selectedOutputDeviceId: id }),
      setOutputMode: (mode) => set({ outputMode: mode }),
      setLocalMonitoringEnabled: (enabled) => set({ localMonitoringEnabled: enabled }),

      refreshMeetingModeStatus: async () => {
        const settings = await deps.getSettings();
        return resolveMeetingModeStatus(settings.preferredVirtualDeviceId);
      },

      startLive: async () => {
        const { selectedVoiceProfileId, selectedMicDeviceId, outputMode } = get();
        if (!selectedVoiceProfileId) {
          set({ state: "ERROR", error: "Select a voice profile before starting Live Voice." });
          return;
        }

        sessionEpoch += 1;
        const epoch = sessionEpoch;

        try {
          set({ state: "CHECKING", error: null, metrics: INITIAL_METRICS });
          const profile = await deps.backendClient.getVoiceProfile(selectedVoiceProfileId);
          if (profile.status !== "READY_FOR_AI_PROCESSING") {
            set({ state: "ERROR", error: "Selected voice is not ready for AI processing." });
            return;
          }
          const engineStatus = await deps.ensureEngineRunning();
          if (!engineStatus.ready) {
            set({
              state: "ERROR",
              error: engineStatus.lastError ?? "VoiceShift AI Engine is unavailable. Check System Check.",
            });
            return;
          }

          const [config, settings] = await Promise.all([deps.getRuntimeConfig(), deps.getSettings()]);

          // Meeting Mode readiness gate (Step 21) — fail BEFORE connecting
          // to the engine or touching the microphone if the virtual device
          // isn't there. Never start a half-configured Meeting Mode
          // session.
          let virtualDeviceId: string | null = null;
          if (outputMode === "meeting") {
            const status = await resolveMeetingModeStatus(settings.preferredVirtualDeviceId);
            if (!status.ready) {
              const reason = !status.installed
                ? `No virtual audio driver detected. Install ${status.provider === "vb-cable" ? "VB-CABLE" : status.provider === "blackhole" ? "BlackHole" : "a supported virtual audio driver"} and check Audio Devices.`
                : status.ambiguous
                  ? "Multiple virtual audio devices found — pick one in Audio Devices."
                  : "Virtual audio device is not ready.";
              set({ state: "ERROR", error: reason });
              return;
            }
            virtualDeviceId = status.playbackDeviceId;
          }

          set({ state: "CONNECTING" });
          engineSampleRate = config.engineSampleRate;
          // Settings > Advanced lets a developer point at a different
          // resident-engine WebSocket URL (Step 34) — honor it when set,
          // otherwise use the audited default host:port from main config.
          const engineWsUrl = settings.engineWsUrlOverride || config.engineWsUrl;
          const client = deps.createEngineClient(engineWsUrl);
          await client.connect();
          engineClient = client;

          set({ state: "LOADING_VOICE" });
          const { referencePaths } = await deps.prepareLocalReferences(selectedVoiceProfileId);
          await client.loadVoice(selectedVoiceProfileId, referencePaths);

          set({ state: "STARTING" });
          await client.openStream();

          const { adapter, routed } = await deps.createOutputAdapter(outputMode, virtualDeviceId);
          if (outputMode === "meeting" && !routed) {
            set({ state: "ERROR", error: "Could not route audio to the virtual device. Check Audio Devices." });
            cleanupResources();
            return;
          }
          outputAdapter = adapter;
          jitterBuffer = new JitterBuffer(settings.jitterBufferMs, (frame) => adapter.play(frame.samples, frame.sampleRate));

          client.onAudioFrame(onEngineAudioFrame);
          client.onStreamError(onEngineStreamError);
          client.onClose(() => {
            if (get().state === "LIVE" || get().state === "STARTING") {
              fail("Connection to the AI engine was lost.");
            }
          });

          chunkDurationMs = settings.chunkSizeMs;
          const capture = deps.createMicCapture();
          micCapture = capture;
          await capture.start({
            deviceId: selectedMicDeviceId ?? undefined,
            targetSampleRate: engineSampleRate,
            chunkSizeMs: settings.chunkSizeMs,
            onChunk: (samples, sampleRate) => {
              const sequence = client.sendAudioFrame(sampleRate, samples);
              if (sequence !== null) sentAt.set(sequence, now());
              set((s) => {
                const sentFrames = sequence !== null ? s.metrics.sentFrames + 1 : s.metrics.sentFrames;
                const rejectedFrames = sequence === null ? s.metrics.rejectedFrames + 1 : s.metrics.rejectedFrames;
                return {
                  metrics: {
                    ...s.metrics,
                    sentFrames,
                    rejectedFrames,
                    queueDepth: Math.max(0, sentFrames - s.metrics.receivedFrames - rejectedFrames),
                  },
                };
              });
            },
            onLevel: (level) => updateMetrics({ inputLevel: level }),
            onDeviceLost: () => fail("Microphone was disconnected."),
          });

          // A callback (onDeviceLost, onClose, ...) may have already ended
          // this session while the mic.start() promise above was pending —
          // in that case ERROR/IDLE was already set and must not be
          // clobbered back to LIVE below.
          if (epoch !== sessionEpoch) return;

          // Device hot-plug (Step 32): if the virtual device disappears
          // mid-session, stop safely rather than silently pretending
          // Meeting Mode is still live.
          if (outputMode === "meeting") {
            unwatchDevices = deps.watchDeviceChanges(async () => {
              const settingsNow = await deps.getSettings();
              const status = await resolveMeetingModeStatus(settingsNow.preferredVirtualDeviceId);
              if (!status.ready || status.playbackDeviceId !== virtualDeviceId) {
                fail("Virtual audio device disappeared.");
              }
            });
          }

          sessionStartedAt = now();
          metricsTimer = setInterval(() => {
            jitterBuffer?.tick();
            const elapsed = sessionStartedAt !== null ? (now() - sessionStartedAt) / 1000 : 0;
            updateMetrics({ sessionDurationSec: elapsed, outputLevel: lastReceivedRms });
          }, METRICS_TICK_MS);

          set({ state: "LIVE" });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },

      stopLive: async () => {
        const state = get().state;
        if (state !== "LIVE" && state !== "STARTING") return;
        sessionEpoch += 1;
        set({ state: "STOPPING" });
        try {
          // Stop the mic (and grab its trailing partial chunk) here, before
          // cleanupResources() also stops it, so it is only ever stopped
          // once.
          const trailing = micCapture?.stop() ?? null;
          micCapture = null;
          if (trailing && trailing.length > 0 && engineClient) {
            engineClient.sendAudioFrame(engineSampleRate, trailing);
          }
          if (engineClient) {
            const finalMetrics = await engineClient.closeStream().catch(() => null);
            if (finalMetrics) {
              updateMetrics({
                droppedChunks: finalMetrics.dropped_chunks,
                endToEndEstimatedLatencyMs: finalMetrics.end_to_end_estimated_latency_ms,
              });
            }
          }
        } finally {
          cleanupResources();
          set({ state: "IDLE" });
        }
      },

      testVoice: async (durationMs = 4000) => {
        // Reuses the exact same startLive pipeline for a bounded duration
        // rather than a separate AI implementation (Step 32).
        await get().startLive();
        if (get().state !== "LIVE") return;
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        await get().stopLive();
      },
    };
  });

  return useStore;
}
