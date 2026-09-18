import { describe, expect, it } from "vitest";
import {
  getVirtualAudioIntegration,
  MacOSVirtualAudioAdapter,
  UnsupportedVirtualAudioAdapter,
  WindowsVirtualAudioAdapter,
} from "@renderer/audio/virtualAudioAdapters";

function device(deviceId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo {
  return { deviceId, kind, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

describe("getVirtualAudioIntegration factory", () => {
  it("returns WindowsVirtualAudioAdapter for win32", () => {
    expect(getVirtualAudioIntegration("win32")).toBeInstanceOf(WindowsVirtualAudioAdapter);
  });
  it("returns MacOSVirtualAudioAdapter for darwin", () => {
    expect(getVirtualAudioIntegration("darwin")).toBeInstanceOf(MacOSVirtualAudioAdapter);
  });
  it("returns UnsupportedVirtualAudioAdapter for linux", () => {
    expect(getVirtualAudioIntegration("linux")).toBeInstanceOf(UnsupportedVirtualAudioAdapter);
  });
});

describe("WindowsVirtualAudioAdapter", () => {
  const adapter = new WindowsVirtualAudioAdapter();

  it("isSupported() is true", () => {
    expect(adapter.isSupported()).toBe(true);
  });

  it("getStatus() delegates to real VB-CABLE detection", () => {
    const status = adapter.getStatus(
      [device("in", "audioinput", "CABLE Output (VB-Audio Virtual Cable)")],
      [device("out", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)")]
    );
    expect(status.provider).toBe("vb-cable");
    expect(status.ready).toBe(true);
    expect(status.platform).toBe("win32");
  });

  it("getSetupInstructions() names CABLE Output as what to select in the meeting app", () => {
    const instructions = adapter.getSetupInstructions();
    expect(instructions.steps.some((s) => s.includes("CABLE Output"))).toBe(true);
    expect(instructions.downloadHint.toLowerCase()).toContain("vb-audio.com");
  });

  it("getSettingsAction() returns a fixed action key, not a raw command", () => {
    expect(adapter.getSettingsAction()).toBe("windows-sound-settings");
  });
});

describe("MacOSVirtualAudioAdapter", () => {
  const adapter = new MacOSVirtualAudioAdapter();

  it("isSupported() is true", () => {
    expect(adapter.isSupported()).toBe(true);
  });

  it("getStatus() delegates to real BlackHole detection", () => {
    const status = adapter.getStatus(
      [device("in", "audioinput", "BlackHole 2ch")],
      [device("out", "audiooutput", "BlackHole 2ch")]
    );
    expect(status.provider).toBe("blackhole");
    expect(status.ready).toBe(true);
    expect(status.platform).toBe("darwin");
  });

  it("getSetupInstructions() names BlackHole 2ch as what to select", () => {
    const instructions = adapter.getSetupInstructions();
    expect(instructions.steps.some((s) => s.includes("BlackHole 2ch"))).toBe(true);
  });

  it("getSettingsAction() returns a fixed action key", () => {
    expect(adapter.getSettingsAction()).toBe("macos-audio-midi-setup");
  });
});

describe("UnsupportedVirtualAudioAdapter", () => {
  const adapter = new UnsupportedVirtualAudioAdapter("linux");

  it("is never supported and never ready", () => {
    expect(adapter.isSupported()).toBe(false);
    expect(adapter.getStatus().ready).toBe(false);
    expect(adapter.getStatus().provider).toBe("none");
  });

  it("getSettingsAction() is null", () => {
    expect(adapter.getSettingsAction()).toBeNull();
  });
});
