import type { AppPlatform, VirtualAudioProvider } from "@shared/types";
import type { SystemAudioSettingsAction, VirtualAudioSetupInstructions, VirtualDeviceStatus } from "@shared/virtualAudio";
import { detectVirtualDevice } from "./virtualDeviceDetection";

/** One integration per platform, isolating all VB-CABLE/BlackHole-specific
 * knowledge behind a single interface (Step 7/12/14) — no React code here,
 * no `if (process.platform === ...)` scattered through screens. Detection
 * itself is pure (see virtualDeviceDetection.ts); these classes just carry
 * the platform identity and the copy/actions specific to that OS. */
export interface VirtualAudioIntegration {
  readonly platform: AppPlatform;
  readonly provider: VirtualAudioProvider;
  isSupported(): boolean;
  getStatus(
    inputDevices: MediaDeviceInfo[],
    outputDevices: MediaDeviceInfo[],
    preferredDeviceId?: string | null
  ): VirtualDeviceStatus;
  getSetupInstructions(): VirtualAudioSetupInstructions;
  /** A fixed action key, not a URL/command string — main resolves it to
   * one specific, hardcoded shell action (see main/ipcHandlers.ts). null
   * when this platform has no known way to jump to system audio settings. */
  getSettingsAction(): SystemAudioSettingsAction | null;
}

export class WindowsVirtualAudioAdapter implements VirtualAudioIntegration {
  readonly platform = "win32" as const;
  readonly provider = "vb-cable" as const;

  isSupported(): boolean {
    return true;
  }

  getStatus(inputDevices: MediaDeviceInfo[], outputDevices: MediaDeviceInfo[], preferredDeviceId: string | null = null) {
    return detectVirtualDevice("win32", inputDevices, outputDevices, preferredDeviceId);
  }

  getSetupInstructions(): VirtualAudioSetupInstructions {
    return {
      title: "Install VB-CABLE (Windows)",
      downloadHint: "Download VB-CABLE from the official VB-Audio site (vb-audio.com) — not bundled with VoiceShift.",
      steps: [
        "Download and run the VB-CABLE installer from vb-audio.com as Administrator.",
        "Restart Windows if the installer asks you to.",
        "Open VoiceShift and re-run System Check — \"VB-CABLE\" should show Installed.",
        'In your meeting app (Meet/Teams/Slack), set the microphone to "CABLE Output (VB-Audio Virtual Cable)".',
        "Keep your headphones/speakers as the meeting app's speaker output — VB-CABLE only replaces the microphone.",
      ],
    };
  }

  getSettingsAction(): SystemAudioSettingsAction {
    return "windows-sound-settings";
  }
}

export class MacOSVirtualAudioAdapter implements VirtualAudioIntegration {
  readonly platform = "darwin" as const;
  readonly provider = "blackhole" as const;

  isSupported(): boolean {
    return true;
  }

  getStatus(inputDevices: MediaDeviceInfo[], outputDevices: MediaDeviceInfo[], preferredDeviceId: string | null = null) {
    return detectVirtualDevice("darwin", inputDevices, outputDevices, preferredDeviceId);
  }

  getSetupInstructions(): VirtualAudioSetupInstructions {
    return {
      title: "Install BlackHole (macOS)",
      downloadHint: "Download BlackHole 2ch from the official existential.audio site — not bundled with VoiceShift.",
      steps: [
        "Download and install BlackHole 2ch from existential.audio.",
        "Grant any installer permissions macOS requests, then restart if prompted.",
        "Open VoiceShift and re-run System Check — \"BlackHole\" should show Installed.",
        'In your meeting app (Meet/Teams/Slack), set the microphone to "BlackHole 2ch".',
        "Keep your normal output device as the meeting app's speaker — BlackHole only replaces the microphone.",
      ],
    };
  }

  getSettingsAction(): SystemAudioSettingsAction {
    return "macos-audio-midi-setup";
  }
}

/** Linux (this dev machine) and any other unrecognized platform — Meeting
 * Mode is never claimed as supported here (Step 56: do not pretend Linux
 * can prove VB-CABLE/BlackHole behavior). */
export class UnsupportedVirtualAudioAdapter implements VirtualAudioIntegration {
  readonly provider = "none" as const;
  constructor(readonly platform: AppPlatform) {}

  isSupported(): boolean {
    return false;
  }

  getStatus(): VirtualDeviceStatus {
    return {
      platform: this.platform,
      provider: "none",
      installed: false,
      ambiguous: false,
      candidates: [],
      playbackDeviceId: null,
      playbackDeviceName: null,
      meetingInputName: null,
      ready: false,
    };
  }

  getSetupInstructions(): VirtualAudioSetupInstructions {
    return {
      title: "Meeting Mode is not available on this platform",
      downloadHint: "Virtual-microphone routing is only implemented for Windows (VB-CABLE) and macOS (BlackHole).",
      steps: [],
    };
  }

  getSettingsAction(): null {
    return null;
  }
}

export function getVirtualAudioIntegration(platform: AppPlatform): VirtualAudioIntegration {
  if (platform === "win32") return new WindowsVirtualAudioAdapter();
  if (platform === "darwin") return new MacOSVirtualAudioAdapter();
  return new UnsupportedVirtualAudioAdapter(platform);
}
