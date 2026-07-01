import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipcChannels";
import type { EngineLogLine, EngineProcessStatus, PersistedSettings, RuntimeConfig } from "../shared/types";
import type { PlatformInfo, VoiceshiftApi } from "../shared/ipcApi";
import type { SystemAudioSettingsAction } from "../shared/virtualAudio";

/** The ENTIRE surface exposed to the renderer. No raw Node/Electron APIs
 * (no fs, no child_process, no ipcRenderer itself) cross this boundary —
 * only these narrow, typed, purpose-built functions. */
const voiceshiftApi: VoiceshiftApi = {
  engine: {
    start: (): Promise<EngineProcessStatus> => ipcRenderer.invoke(IPC.ENGINE_START),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.ENGINE_STOP),
    restart: (): Promise<EngineProcessStatus> => ipcRenderer.invoke(IPC.ENGINE_RESTART),
    getStatus: (): Promise<EngineProcessStatus> => ipcRenderer.invoke(IPC.ENGINE_STATUS),
    healthCheck: (): Promise<boolean> => ipcRenderer.invoke(IPC.ENGINE_HEALTH_CHECK),
    onLog: (callback: (line: EngineLogLine) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: EngineLogLine) => callback(line);
      ipcRenderer.on(IPC.ENGINE_LOG, handler);
      return () => ipcRenderer.removeListener(IPC.ENGINE_LOG, handler);
    },
    onStatusChange: (callback: (status: EngineProcessStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: EngineProcessStatus) => callback(status);
      ipcRenderer.on(IPC.ENGINE_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.ENGINE_STATUS_CHANGED, handler);
    },
  },
  settings: {
    get: (): Promise<PersistedSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<PersistedSettings>): Promise<PersistedSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  },
  config: {
    get: (): Promise<RuntimeConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),
  },
  platform: {
    getInfo: (): Promise<PlatformInfo> => ipcRenderer.invoke(IPC.PLATFORM_INFO),
    openAudioSettings: (action: SystemAudioSettingsAction): Promise<boolean> =>
      ipcRenderer.invoke(IPC.PLATFORM_OPEN_AUDIO_SETTINGS, action),
  },
  voiceProfile: {
    /** Fetches this profile's VALID reference samples from the backend and
     * writes them to a local scratch directory the resident engine process
     * can read, returning those paths for use with EngineClient.loadVoice.
     * See src/main/voiceReferenceMaterializer.ts. */
    prepareLocalReferences: (voiceProfileId: string): Promise<{ referencePaths: string[] }> =>
      ipcRenderer.invoke(IPC.VOICE_PREPARE_LOCAL_REFERENCES, voiceProfileId),
  },
};

contextBridge.exposeInMainWorld("voiceshift", voiceshiftApi);
