/** IPC channel name constants shared by main and preload. Lives in
 * src/shared/ (not src/main/ipcHandlers.ts) specifically so the preload
 * bundle never needs to import anything from main/ — main/ipcHandlers.ts
 * transitively pulls in Node built-ins (fs, child_process via
 * voiceReferenceMaterializer/engineProcessManager) that are unavailable in
 * Electron's sandboxed preload context (webPreferences.sandbox: true). */
export const IPC = {
  ENGINE_START: "engine:start",
  ENGINE_STOP: "engine:stop",
  ENGINE_RESTART: "engine:restart",
  ENGINE_STATUS: "engine:status",
  ENGINE_HEALTH_CHECK: "engine:healthCheck",
  ENGINE_LOG: "engine:log", // main -> renderer push, see main/index.ts
  ENGINE_STATUS_CHANGED: "engine:statusChanged", // main -> renderer push, see main/index.ts
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  CONFIG_GET: "config:get",
  PLATFORM_INFO: "platform:info",
  PLATFORM_OPEN_AUDIO_SETTINGS: "platform:openAudioSettings",
  VOICE_PREPARE_LOCAL_REFERENCES: "voiceProfile:prepareLocalReferences",
} as const;
