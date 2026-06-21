import { app, ipcMain, shell } from "electron";
import type { EngineProcessManager } from "./engineProcessManager";
import type { SettingsStore } from "./settingsStore";
import type { PlatformAudioIntegration } from "./platform";
import type { MainConfig } from "./config";
import { materializeReferenceFiles } from "./voiceReferenceMaterializer";
import type { PersistedSettings } from "../shared/types";
import type { SystemAudioSettingsAction } from "../shared/virtualAudio";
import { IPC } from "../shared/ipcChannels";

/** Each key resolves to exactly one hardcoded, non-user-controlled shell
 * action — the renderer only ever sends the fixed action name, never a raw
 * path/URL/command (Step 12: "do not execute unsafe arbitrary shell
 * commands"). */
export async function openSystemAudioSettings(action: SystemAudioSettingsAction): Promise<boolean> {
  if (action === "windows-sound-settings") {
    // ms-settings: URIs only resolve on Windows; harmless no-op elsewhere.
    return shell.openExternal("ms-settings:sound").then(
      () => true,
      () => false
    );
  }
  if (action === "macos-audio-midi-setup") {
    const result = await shell.openPath("/System/Applications/Utilities/Audio MIDI Setup.app");
    return result === "";
  }
  return false;
}

/** Registers every renderer-invokable (`ipcRenderer.invoke`) handler. The
 * two main -> renderer push channels (ENGINE_LOG, ENGINE_STATUS_CHANGED)
 * are wired directly in index.ts, where the window reference and the
 * manager's onLog/onStatusChange callbacks are constructed together. */
export function registerIpcHandlers(deps: {
  engineProcessManager: EngineProcessManager;
  settingsStore: SettingsStore;
  platformIntegration: PlatformAudioIntegration;
  config: MainConfig;
  scratchRoot: string;
}): void {
  const { engineProcessManager, settingsStore, platformIntegration, config, scratchRoot } = deps;

  ipcMain.handle(IPC.ENGINE_START, async () => engineProcessManager.start());
  ipcMain.handle(IPC.ENGINE_STOP, async () => engineProcessManager.stop());
  ipcMain.handle(IPC.ENGINE_RESTART, async () => engineProcessManager.restart());
  ipcMain.handle(IPC.ENGINE_STATUS, () => engineProcessManager.getStatus());
  ipcMain.handle(IPC.ENGINE_HEALTH_CHECK, async () => engineProcessManager.healthCheck());

  ipcMain.handle(IPC.SETTINGS_GET, () => settingsStore.get());
  ipcMain.handle(IPC.SETTINGS_SET, (_event, patch: Partial<PersistedSettings>) => settingsStore.set(patch));

  ipcMain.handle(IPC.CONFIG_GET, () => ({
    backendUrl: config.backendUrl,
    engineHost: config.engineHost,
    engineWsPort: config.engineWsPort,
    engineWsUrl: config.engineWsUrl,
    engineSampleRate: config.engineSampleRate,
    platform: process.platform,
    appVersion: process.env.npm_package_version ?? "0.1.0",
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle(IPC.PLATFORM_INFO, () => ({
    name: platformIntegration.name,
    supportsVirtualAudioOutput: platformIntegration.supportsVirtualAudioOutput(),
    virtualOutputDeviceHints: platformIntegration.listVirtualOutputDeviceHints(),
  }));

  ipcMain.handle(IPC.PLATFORM_OPEN_AUDIO_SETTINGS, (_event, action: SystemAudioSettingsAction) =>
    openSystemAudioSettings(action)
  );

  ipcMain.handle(IPC.VOICE_PREPARE_LOCAL_REFERENCES, async (_event, voiceProfileId: string) => {
    const currentSettings = settingsStore.get();
    const backendUrl = currentSettings.backendUrlOverride ?? config.backendUrl;
    const referencePaths = await materializeReferenceFiles(backendUrl, voiceProfileId, scratchRoot);
    return { referencePaths };
  });
}
