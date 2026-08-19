/** Shared types crossing the preload contextBridge boundary. Keep this the
 * single source of truth for the renderer<->main IPC contract's data
 * shapes — main, preload, and renderer all import from here so the shape
 * can never drift between the three processes. */

export type EngineMode = "external" | "managed";

export interface EngineProcessStatus {
  mode: EngineMode;
  running: boolean;
  ready: boolean;
  pid: number | null;
  startedAt: number | null;
  lastError: string | null;
  restartCount: number;
}

export interface EngineLogLine {
  stream: "stdout" | "stderr";
  line: string;
  timestamp: number;
}

export type ChunkSizeMs = 250 | 500 | 750 | 1000;

/** "local" = converted audio plays through the user's own speakers/
 * headphones (Phase 4 behavior). "meeting" = converted audio routes to a
 * virtual audio device (VB-CABLE on Windows, BlackHole on macOS) so a
 * meeting app can select it as its microphone — see
 * docs/phase5-virtual-audio.md. Never called "microphone" in local mode;
 * this is a playback-side concept even in meeting mode (VoiceShift never
 * touches the meeting app's actual mic selection). */
export type OutputMode = "local" | "meeting";

export type VirtualAudioProvider = "vb-cable" | "blackhole" | "none";

export interface PersistedSettings {
  microphoneDeviceId: string | null;
  outputDeviceId: string | null;
  voiceProfileId: string | null;
  engineMode: EngineMode;
  chunkSizeMs: ChunkSizeMs;
  jitterBufferMs: number;
  backendUrlOverride: string | null;
  engineWsUrlOverride: string | null;
  debugMetrics: boolean;
  debugRecordingEnabled: boolean;
  outputMode: OutputMode;
  /** OFF by default in Meeting Mode (Step 29) — when on, converted audio
   * also plays locally through outputDeviceId in addition to the virtual
   * device, from the SAME converted PCM (never a second AI pass — see
   * DualOutputAdapter). */
  localMonitoringEnabled: boolean;
  /** Only meaningful when getVirtualAudioIntegration(...).getStatus(...)
   * reports `ambiguous: true` (more than one candidate device matched,
   * e.g. two BlackHole variants installed) — lets the user pin which one
   * VoiceShift should use instead of guessing. */
  preferredVirtualDeviceId: string | null;
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  microphoneDeviceId: null,
  outputDeviceId: null,
  voiceProfileId: null,
  engineMode: "managed",
  // Phase 3.2's measured-balanced chunk size (see docs/phase3.2-openvoice-onnx.md):
  // the smallest chunk size that kept sustained streaming RTF < 1.0 with a
  // stable queue in the real benchmark.
  chunkSizeMs: 500,
  jitterBufferMs: 200,
  backendUrlOverride: null,
  engineWsUrlOverride: null,
  debugMetrics: false,
  debugRecordingEnabled: false,
  outputMode: "local",
  localMonitoringEnabled: false,
  preferredVirtualDeviceId: null,
};

export type AppPlatform = "win32" | "darwin" | "linux";

export interface RuntimeConfig {
  backendUrl: string;
  engineHost: string;
  engineWsPort: number;
  /** The exact ws:// URL to connect EngineClient to — computed once in
   * main/config.ts (see shared/serviceConfig.ts). Use this directly rather
   * than reconstructing `ws://${engineHost}:${engineWsPort}` elsewhere. */
  engineWsUrl: string;
  /** The resident engine's actual input/output PCM sample rate — for
   * openvoice_onnx this is ai-worker's Settings.openvoice_sample_rate
   * (22050 by default; see ai-worker/app/core/config.py). The engine
   * resamples server-side too (see OpenVoiceOnnxEngine.process_chunk's
   * `_resample_if_needed`), but the desktop still resamples once,
   * client-side, to this rate before sending — see docs/phase4-desktop.md
   * "Microphone Pipeline" for why one resampling boundary beats relying on
   * the server-side fallback. */
  engineSampleRate: number;
  platform: AppPlatform;
  appVersion: string;
  isPackaged: boolean;
}
