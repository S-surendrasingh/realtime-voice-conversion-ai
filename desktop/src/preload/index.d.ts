import type { VoiceshiftApi } from "../shared/ipcApi";

declare global {
  interface Window {
    voiceshift: VoiceshiftApi;
  }
}
