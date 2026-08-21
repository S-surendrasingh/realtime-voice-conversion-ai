import type { AppPlatform, VirtualAudioProvider } from "./types";

/** A snapshot of virtual-audio-device state, computed synchronously from a
 * device list already enumerated by the caller (see
 * audio/virtualDeviceDetection.ts) — matches the shape from the Phase 5
 * spec's Step 8 example exactly (playbackDeviceName/meetingInputName). */
export interface VirtualDeviceStatus {
  platform: AppPlatform;
  provider: VirtualAudioProvider;
  installed: boolean;
  /** True when more than one plausible playback-side candidate was found
   * (e.g. two BlackHole variants) and none was disambiguated via a
   * preferred device id — the caller must not guess in this case. */
  ambiguous: boolean;
  candidates: Array<{ deviceId: string; label: string }>;
  playbackDeviceId: string | null;
  playbackDeviceName: string | null;
  /** The device name the user should select as their microphone inside
   * Meet/Teams/Slack — VoiceShift never selects this itself (Step 6/24). */
  meetingInputName: string | null;
  /** installed && not ambiguous (or disambiguated) && a playback device
   * was actually resolved. Never true just because the AI engine is ready
   * (Step 17). */
  ready: boolean;
}

export interface VirtualAudioSetupInstructions {
  title: string;
  downloadHint: string;
  steps: string[];
}

/** A fixed, non-user-controlled action name main resolves to a specific
 * `shell.openExternal`/`shell.openPath` call — never an arbitrary string
 * from the renderer (Step 12: "do not execute unsafe arbitrary shell
 * commands"). */
export type SystemAudioSettingsAction = "windows-sound-settings" | "macos-audio-midi-setup";
