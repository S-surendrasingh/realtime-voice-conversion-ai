// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternalMock = vi.fn();
const openPathMock = vi.fn();
vi.mock("electron", () => ({
  shell: {
    openExternal: (...args: unknown[]) => openExternalMock(...args),
    openPath: (...args: unknown[]) => openPathMock(...args),
  },
  ipcMain: { handle: vi.fn() },
}));

const { openSystemAudioSettings } = await import("../../src/main/ipcHandlers");

describe("openSystemAudioSettings", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    openPathMock.mockReset();
  });

  it("opens ms-settings:sound for windows-sound-settings via a FIXED string, not user input", async () => {
    openExternalMock.mockResolvedValue(undefined);
    const ok = await openSystemAudioSettings("windows-sound-settings");
    expect(openExternalMock).toHaveBeenCalledWith("ms-settings:sound");
    expect(ok).toBe(true);
  });

  it("returns false if openExternal rejects", async () => {
    openExternalMock.mockRejectedValue(new Error("no handler on this OS"));
    const ok = await openSystemAudioSettings("windows-sound-settings");
    expect(ok).toBe(false);
  });

  it("opens the Audio MIDI Setup app bundle for macos-audio-midi-setup", async () => {
    openPathMock.mockResolvedValue(""); // shell.openPath resolves "" on success
    const ok = await openSystemAudioSettings("macos-audio-midi-setup");
    expect(openPathMock).toHaveBeenCalledWith("/System/Applications/Utilities/Audio MIDI Setup.app");
    expect(ok).toBe(true);
  });

  it("returns false when openPath reports an error string", async () => {
    openPathMock.mockResolvedValue("app not found");
    const ok = await openSystemAudioSettings("macos-audio-midi-setup");
    expect(ok).toBe(false);
  });
});
