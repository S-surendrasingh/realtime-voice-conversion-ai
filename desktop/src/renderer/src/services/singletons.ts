import { BackendClient } from "./BackendClient";
import { EngineClient } from "./EngineClient";
import { MicCapture } from "../audio/MicCapture";
import { DualOutputAdapter, LocalPlaybackAdapter, VirtualAudioOutputAdapter } from "../audio/outputAdapter";
import { createLiveVoiceStore } from "../stores/liveVoiceStore";
import type { OutputMode, RuntimeConfig } from "@shared/types";

let cachedConfig: RuntimeConfig | null = null;
let cachedBackendClient: BackendClient | null = null;

async function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (!cachedConfig) {
    cachedConfig = await window.voiceshift.config.get();
  }
  return cachedConfig;
}

/** Lazily built so a fresh backend URL from settings (an override) is
 * picked up without restarting the app — see Settings screen. */
export async function getBackendClient(): Promise<BackendClient> {
  if (cachedBackendClient) return cachedBackendClient;
  const settings = await window.voiceshift.settings.get();
  const config = await getRuntimeConfig();
  cachedBackendClient = new BackendClient(settings.backendUrlOverride ?? config.backendUrl);
  return cachedBackendClient;
}

/** Real wiring for the live-voice state machine — the one place that
 * connects it to actual browser audio APIs, a real EngineClient, and the
 * real preload IPC bridge. Tests use createLiveVoiceStore directly with
 * fakes instead of importing this module. */
export const useLiveVoiceStore = createLiveVoiceStore({
  backendClient: {
    getVoiceProfile: async (id: string) => (await getBackendClient()).getVoiceProfile(id),
  },
  getRuntimeConfig,
  getSettings: () => window.voiceshift.settings.get(),
  ensureEngineRunning: async () => {
    const status = await window.voiceshift.engine.getStatus();
    if (status.ready) return status;
    return window.voiceshift.engine.start();
  },
  prepareLocalReferences: (voiceProfileId: string) => window.voiceshift.voiceProfile.prepareLocalReferences(voiceProfileId),
  createEngineClient: (url: string) => new EngineClient(url),
  createMicCapture: () => new MicCapture(),

  createOutputAdapter: async (mode: OutputMode, virtualDeviceId: string | null) => {
    if (mode === "local") {
      return { adapter: new LocalPlaybackAdapter(), routed: true };
    }
    // Meeting Mode. virtualDeviceId is guaranteed non-null here — the
    // store's readiness gate only calls this with mode "meeting" after
    // getVirtualAudioIntegration(...).getStatus(...) already confirmed
    // `ready: true`, which requires a resolved playbackDeviceId.
    const virtual = new VirtualAudioOutputAdapter(virtualDeviceId!);
    const routed = await virtual.ensureRouted();
    if (!routed) return { adapter: virtual, routed: false };

    const settings = await window.voiceshift.settings.get();
    if (!settings.localMonitoringEnabled) {
      return { adapter: virtual, routed: true };
    }
    // Optional local monitoring (Step 29/30) — same converted PCM fanned
    // out to the user's normal speakers too, via a second, independent
    // LocalPlaybackAdapter (never a second AI pass).
    return { adapter: new DualOutputAdapter(virtual, new LocalPlaybackAdapter()), routed: true };
  },

  enumerateDevices: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputDevices: devices.filter((d) => d.kind === "audioinput"),
      outputDevices: devices.filter((d) => d.kind === "audiooutput"),
    };
  },

  watchDeviceChanges: (callback: () => void) => {
    navigator.mediaDevices.addEventListener("devicechange", callback);
    return () => navigator.mediaDevices.removeEventListener("devicechange", callback);
  },
});
