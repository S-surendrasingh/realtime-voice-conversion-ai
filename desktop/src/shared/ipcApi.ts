/** The typed contract exposed across the preload contextBridge boundary.
 * Defined here (not in src/preload/index.ts) so both the preload
 * implementation and the renderer's global Window typing can import the
 * same interface without either tsconfig project needing to include the
 * other side's files. */
import type { EngineLogLine, EngineProcessStatus, PersistedSettings, RuntimeConfig } from "./types";
import type { SystemAudioSettingsAction } from "./virtualAudio";

export interface PlatformInfo {
  name: string;
  supportsVirtualAudioOutput: boolean;
  virtualOutputDeviceHints: string[];
}

export interface VoiceshiftApi {
  engine: {
    start(): Promise<EngineProcessStatus>;
    stop(): Promise<void>;
    restart(): Promise<EngineProcessStatus>;
    getStatus(): Promise<EngineProcessStatus>;
    healthCheck(): Promise<boolean>;
    onLog(callback: (line: EngineLogLine) => void): () => void;
    onStatusChange(callback: (status: EngineProcessStatus) => void): () => void;
  };
  settings: {
    get(): Promise<PersistedSettings>;
    set(patch: Partial<PersistedSettings>): Promise<PersistedSettings>;
  };
  config: {
    get(): Promise<RuntimeConfig>;
  };
  platform: {
    getInfo(): Promise<PlatformInfo>;
    /** Best-effort — resolves false if the OS/action combination has
     * nothing to open (e.g. called on Linux). Never accepts an arbitrary
     * string: only the fixed SystemAudioSettingsAction keys. */
    openAudioSettings(action: SystemAudioSettingsAction): Promise<boolean>;
  };
  voiceProfile: {
    prepareLocalReferences(voiceProfileId: string): Promise<{ referencePaths: string[] }>;
  };
}
