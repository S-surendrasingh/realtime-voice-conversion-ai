import { describe, expect, it } from "vitest";
import { detectVirtualDevice, providerForPlatform } from "@renderer/audio/virtualDeviceDetection";

function device(deviceId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo {
  return { deviceId, kind, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

describe("providerForPlatform", () => {
  it("maps win32 -> vb-cable, darwin -> blackhole, linux -> null", () => {
    expect(providerForPlatform("win32")).toBe("vb-cable");
    expect(providerForPlatform("darwin")).toBe("blackhole");
    expect(providerForPlatform("linux")).toBeNull();
  });
});

describe("detectVirtualDevice on linux", () => {
  it("is never ready — no supported provider", () => {
    const status = detectVirtualDevice("linux", [], []);
    expect(status.provider).toBe("none");
    expect(status.ready).toBe(false);
    expect(status.installed).toBe(false);
  });
});

describe("detectVirtualDevice on windows (VB-CABLE)", () => {
  it("reports not installed when no CABLE devices are present", () => {
    const status = detectVirtualDevice(
      "win32",
      [device("mic1", "audioinput", "Built-in Microphone")],
      [device("spk1", "audiooutput", "Speakers")]
    );
    expect(status.installed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.playbackDeviceId).toBeNull();
  });

  it("detects CABLE Input as the playback device and CABLE Output as the meeting input name", () => {
    const status = detectVirtualDevice(
      "win32",
      [
        device("mic1", "audioinput", "Built-in Microphone"),
        device("cable-out", "audioinput", "CABLE Output (VB-Audio Virtual Cable)"),
      ],
      [
        device("spk1", "audiooutput", "Speakers"),
        device("cable-in", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
      ]
    );
    expect(status.installed).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.playbackDeviceId).toBe("cable-in");
    expect(status.playbackDeviceName).toMatch(/CABLE Input/);
    expect(status.meetingInputName).toMatch(/CABLE Output/);
  });

  it("never confuses CABLE Output (an input device) for the playback target", () => {
    // A pathological device list where "CABLE Output" also somehow shows
    // up in the output list must still not be selected as playback unless
    // it actually matches the playback pattern (it doesn't — only "CABLE
    // Input" does).
    const status = detectVirtualDevice(
      "win32",
      [],
      [device("weird", "audiooutput", "CABLE Output (VB-Audio Virtual Cable)")]
    );
    expect(status.installed).toBe(false);
    expect(status.playbackDeviceId).toBeNull();
  });

  it("flags ambiguous when multiple CABLE-like output devices exist and none preferred", () => {
    const outputs = [
      device("cable-a", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
      device("cable-b", "audiooutput", "CABLE-A Input (VB-Audio Virtual Cable A)"),
    ];
    const status = detectVirtualDevice("win32", [], outputs);
    expect(status.installed).toBe(true);
    expect(status.ambiguous).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.candidates).toHaveLength(2);
  });

  it("resolves ambiguity when a preferredDeviceId matches one candidate", () => {
    const outputs = [
      device("cable-a", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
      device("cable-b", "audiooutput", "CABLE-A Input (VB-Audio Virtual Cable A)"),
    ];
    const status = detectVirtualDevice("win32", [], outputs, "cable-b");
    expect(status.ambiguous).toBe(false);
    expect(status.ready).toBe(true);
    expect(status.playbackDeviceId).toBe("cable-b");
  });

  it("ignores a preferredDeviceId that doesn't match any candidate (stays ambiguous)", () => {
    const outputs = [
      device("cable-a", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
      device("cable-b", "audiooutput", "CABLE-A Input (VB-Audio Virtual Cable A)"),
    ];
    const status = detectVirtualDevice("win32", [], outputs, "nonexistent");
    expect(status.ambiguous).toBe(true);
    expect(status.ready).toBe(false);
  });
});

describe("detectVirtualDevice on macos (BlackHole)", () => {
  it("detects BlackHole as both playback device and meeting input name", () => {
    const status = detectVirtualDevice(
      "darwin",
      [device("bh-in", "audioinput", "BlackHole 2ch")],
      [device("bh-out", "audiooutput", "BlackHole 2ch")]
    );
    expect(status.installed).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.playbackDeviceId).toBe("bh-out");
    expect(status.meetingInputName).toBe("BlackHole 2ch");
  });

  it("reports not installed when BlackHole is absent", () => {
    const status = detectVirtualDevice(
      "darwin",
      [device("mic1", "audioinput", "MacBook Pro Microphone")],
      [device("spk1", "audiooutput", "MacBook Pro Speakers")]
    );
    expect(status.installed).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("flags ambiguous with two BlackHole variants installed", () => {
    const outputs = [
      device("bh2", "audiooutput", "BlackHole 2ch"),
      device("bh16", "audiooutput", "BlackHole 16ch"),
    ];
    const status = detectVirtualDevice("darwin", [], outputs);
    expect(status.ambiguous).toBe(true);
    expect(status.candidates.map((c) => c.label)).toEqual(["BlackHole 2ch", "BlackHole 16ch"]);
  });

  it("ignores devices with an empty label (permission not yet granted)", () => {
    const status = detectVirtualDevice("darwin", [], [device("bh-out", "audiooutput", "")]);
    expect(status.installed).toBe(false);
  });
});
