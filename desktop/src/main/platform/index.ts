/** OS-specific integration points, isolated behind one interface so
 * Phase 5's Windows (VB-CABLE) and macOS (BlackHole) virtual-audio-output
 * work can land without touching mic capture, EngineClient, or
 * StreamSession. Only LinuxDevIntegration is implemented and exercised in
 * Phase 4 — this dev machine is Linux. The Windows/macOS classes are
 * documented stubs; do not claim they are verified. */
export interface PlatformAudioIntegration {
  readonly name: "linux-dev" | "windows" | "macos";
  /** True once this platform has a real virtual-audio-output integration
   * (VB-CABLE on Windows, BlackHole on macOS) wired up. Always false in
   * Phase 4 for every platform, including this one. */
  supportsVirtualAudioOutput(): boolean;
  /** Enumerates virtual output devices this integration knows how to
   * route to (e.g. a VB-CABLE input device). Empty until Phase 5. */
  listVirtualOutputDeviceHints(): string[];
}

export class LinuxDevIntegration implements PlatformAudioIntegration {
  readonly name = "linux-dev" as const;
  supportsVirtualAudioOutput(): boolean {
    return false;
  }
  listVirtualOutputDeviceHints(): string[] {
    return [];
  }
}

/** Not implemented in Phase 4. Documents the intended Phase 5 integration
 * point: routing converted audio into a VB-CABLE virtual input so it can
 * be selected as the microphone in Meet/Teams/Slack. */
export class WindowsIntegration implements PlatformAudioIntegration {
  readonly name = "windows" as const;
  supportsVirtualAudioOutput(): boolean {
    return false;
  }
  listVirtualOutputDeviceHints(): string[] {
    return ["CABLE Input (VB-Audio Virtual Cable)"];
  }
}

/** Not implemented in Phase 4. Documents the intended Phase 5 integration
 * point: routing converted audio into a BlackHole virtual output so it can
 * be selected as the input in Meet/Teams/Slack. */
export class MacOSIntegration implements PlatformAudioIntegration {
  readonly name = "macos" as const;
  supportsVirtualAudioOutput(): boolean {
    return false;
  }
  listVirtualOutputDeviceHints(): string[] {
    return ["BlackHole 2ch"];
  }
}

export function getPlatformIntegration(platform: NodeJS.Platform): PlatformAudioIntegration {
  if (platform === "win32") return new WindowsIntegration();
  if (platform === "darwin") return new MacOSIntegration();
  return new LinuxDevIntegration();
}
