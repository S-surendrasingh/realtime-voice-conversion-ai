import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PersistedSettings } from "@shared/types";

const { useMediaDevicesMock, useSettingsMock, useLiveVoiceStoreMock } = vi.hoisted(() => ({
  useMediaDevicesMock: vi.fn(),
  useSettingsMock: vi.fn(),
  useLiveVoiceStoreMock: vi.fn(),
}));

vi.mock("@renderer/hooks/useMediaDevices", () => ({
  useMediaDevices: useMediaDevicesMock,
}));

vi.mock("@renderer/hooks/useSettings", () => ({
  useSettings: useSettingsMock,
}));

vi.mock("@renderer/services/singletons", () => ({
  useLiveVoiceStore: useLiveVoiceStoreMock,
}));

import { AudioDevicesScreen } from "@renderer/screens/AudioDevicesScreen";

function makeDevice(kind: "audioinput" | "audiooutput", deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    kind,
    label,
    groupId: `${deviceId}-group`,
    toJSON() {
      return this;
    },
  } as MediaDeviceInfo;
}

function baseSettings(): PersistedSettings {
  return {
    microphoneDeviceId: null,
    outputDeviceId: null,
    voiceProfileId: null,
    engineMode: "managed",
    chunkSizeMs: 500,
    jitterBufferMs: 200,
    backendUrlOverride: null,
    engineWsUrlOverride: null,
    debugMetrics: false,
    debugRecordingEnabled: false,
    outputMode: "local",
    localMonitoringEnabled: false,
    preferredVirtualDeviceId: null,
  };
}

// --- Minimal fake Web Audio graph -----------------------------------------
// jsdom implements none of this, so every node is a hand-rolled chainable
// no-op. connect() returns its argument so `a.connect(b).connect(c)` works.

function makeFakeAnalyser() {
  return {
    fftSize: 2048,
    connect: vi.fn((dest: unknown) => dest),
    getFloatTimeDomainData: vi.fn(),
  };
}

function makeFakeGain() {
  return {
    connect: vi.fn((dest: unknown) => dest),
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  };
}

function makeFakeOscillator() {
  return {
    frequency: { value: 0 },
    connect: vi.fn((dest: unknown) => dest),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

const audioContextInstances: FakeAudioContext[] = [];

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  close = vi.fn().mockResolvedValue(undefined);
  setSinkId = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => makeFakeAnalyser());
  createGain = vi.fn(() => makeFakeGain());
  createOscillator = vi.fn(() => makeFakeOscillator());

  constructor() {
    audioContextInstances.push(this);
  }
}

function makeFakeStream(sampleRate: number | undefined = 48000) {
  const track = {
    stop: vi.fn(),
    getSettings: vi.fn(() => (sampleRate != null ? { sampleRate } : {})),
  };
  return {
    getTracks: vi.fn(() => [track]),
    getAudioTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
}

describe("AudioDevicesScreen", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getUserMedia = vi.fn().mockResolvedValue(makeFakeStream());
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
      writable: true,
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);

    useSettingsMock.mockReturnValue({ settings: baseSettings(), update: vi.fn().mockResolvedValue(baseSettings()) });
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [],
      outputDevices: [],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });
    useLiveVoiceStoreMock.mockReturnValue({
      meetingModeStatus: null,
      refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    audioContextInstances.length = 0;
  });

  it("renders device lists with labels, falling back to a generic label when empty", () => {
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [makeDevice("audioinput", "mic-1", "Built-in Mic"), makeDevice("audioinput", "mic-2", "")],
      outputDevices: [makeDevice("audiooutput", "out-1", "Headphones"), makeDevice("audiooutput", "out-2", "")],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    expect(screen.getByRole("option", { name: "Built-in Mic" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Microphone" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Headphones" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Output device" })).toBeInTheDocument();
  });

  it("shows a grant-access button when permission is not granted, and calls requestPermission", async () => {
    const requestPermission = vi.fn();
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [],
      outputDevices: [],
      permission: "denied",
      requestPermission,
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    expect(screen.getAllByText(/denied/i).length).toBeGreaterThan(0);
    const grantBtn = screen.getByRole("button", { name: /grant microphone access/i });
    const user = userEvent.setup();
    await user.click(grantBtn);
    expect(requestPermission).toHaveBeenCalledTimes(1);

    // Devices aren't pretended to be usable — the mic test button stays disabled.
    expect(screen.getByRole("button", { name: /test microphone/i })).toBeDisabled();
  });

  it("selecting an input device persists it via update()", async () => {
    const update = vi.fn().mockResolvedValue(baseSettings());
    useSettingsMock.mockReturnValue({ settings: baseSettings(), update });
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [makeDevice("audioinput", "mic-1", "Built-in Mic")],
      outputDevices: [makeDevice("audiooutput", "out-1", "Headphones")],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    const selects = screen.getAllByRole("combobox");
    const user = userEvent.setup();
    await user.selectOptions(selects[0], "mic-1");

    expect(update).toHaveBeenCalledWith({ microphoneDeviceId: "mic-1" });
  });

  it("selecting an output device persists it via update()", async () => {
    const update = vi.fn().mockResolvedValue(baseSettings());
    useSettingsMock.mockReturnValue({ settings: baseSettings(), update });
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [makeDevice("audioinput", "mic-1", "Built-in Mic")],
      outputDevices: [makeDevice("audiooutput", "out-1", "Headphones")],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    const selects = screen.getAllByRole("combobox");
    const user = userEvent.setup();
    await user.selectOptions(selects[1], "out-1");

    expect(update).toHaveBeenCalledWith({ outputDeviceId: "out-1" });
  });

  it("clicking Test Microphone calls getUserMedia and cleans up on Stop Test", async () => {
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [makeDevice("audioinput", "mic-1", "Built-in Mic")],
      outputDevices: [],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /test microphone/i }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: /stop test/i })).toBeInTheDocument();
    expect(await screen.findByText("48000 Hz")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /stop test/i }));

    expect(await screen.findByRole("button", { name: /test microphone/i })).toBeInTheDocument();
  });

  it("does not leak the mic stream/AudioContext when unmounted mid-test", async () => {
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [],
      outputDevices: [],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    const { unmount } = render(<AudioDevicesScreen />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /test microphone/i }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    expect(() => unmount()).not.toThrow();
  });

  it("clicking Test Output constructs an AudioContext and starts an oscillator without throwing", async () => {
    useMediaDevicesMock.mockReturnValue({
      inputDevices: [],
      outputDevices: [makeDevice("audiooutput", "out-1", "Headphones")],
      permission: "granted",
      requestPermission: vi.fn(),
      refresh: vi.fn(),
    });

    render(<AudioDevicesScreen />);

    const user = userEvent.setup();
    await expect(user.click(screen.getByRole("button", { name: /test output/i }))).resolves.not.toThrow();

    await waitFor(() => expect(audioContextInstances.length).toBe(1));
    const ctx = audioContextInstances[0];
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator.mock.results[0].value.start).toHaveBeenCalled();

    // The button reflects the in-progress test.
    expect(await screen.findByRole("button", { name: /playing/i })).toBeInTheDocument();
  });

  describe("Virtual Microphone", () => {
    it("shows Not Installed when no virtual device is detected", () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: false,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);
      expect(screen.getByText("Not Installed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /test virtual microphone/i })).toBeDisabled();
    });

    it('"Open Audio Settings" appears only when not installed, and calls the fixed action key via IPC', async () => {
      const openAudioSettings = vi.fn().mockResolvedValue(true);
      (window as unknown as { voiceshift: Record<string, unknown> }).voiceshift = {
        platform: { openAudioSettings },
      };
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: false,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /open audio settings/i }));
      expect(openAudioSettings).toHaveBeenCalledWith("windows-sound-settings");
    });

    it('"Open Audio Settings" is not shown once the device is installed', () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: true,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: "cable-in",
          playbackDeviceName: "CABLE Input (VB-Audio Virtual Cable)",
          meetingInputName: "CABLE Output (VB-Audio Virtual Cable)",
          ready: true,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);
      expect(screen.queryByRole("button", { name: /open audio settings/i })).not.toBeInTheDocument();
    });

    it("shows Ready plus provider/playback/meeting device names when detected", () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: true,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: "cable-in",
          playbackDeviceName: "CABLE Input (VB-Audio Virtual Cable)",
          meetingInputName: "CABLE Output (VB-Audio Virtual Cable)",
          ready: true,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);
      expect(screen.getByText("Ready")).toBeInTheDocument();
      expect(screen.getByText("VB-CABLE")).toBeInTheDocument();
      expect(screen.getByText("CABLE Input (VB-Audio Virtual Cable)")).toBeInTheDocument();
      expect(screen.getByText("CABLE Output (VB-Audio Virtual Cable)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /test virtual microphone/i })).not.toBeDisabled();
    });

    it("shows a device picker when ambiguous, and selecting one persists preferredVirtualDeviceId and re-checks", async () => {
      const update = vi.fn().mockResolvedValue(baseSettings());
      const refreshMeetingModeStatus = vi.fn().mockResolvedValue(null);
      useSettingsMock.mockReturnValue({ settings: baseSettings(), update });
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: true,
          ambiguous: true,
          candidates: [
            { deviceId: "a", label: "CABLE Input (VB-Audio Virtual Cable)" },
            { deviceId: "b", label: "CABLE-A Input (VB-Audio Virtual Cable A)" },
          ],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus,
      });
      render(<AudioDevicesScreen />);

      expect(screen.getByText("Ambiguous — pick one below")).toBeInTheDocument();
      const user = userEvent.setup();
      // Input Microphone + Output Device selects are also on screen; the
      // "Which device?" picker is the last combobox rendered.
      await user.selectOptions(screen.getAllByRole("combobox").at(-1)!, "b");

      expect(update).toHaveBeenCalledWith({ preferredVirtualDeviceId: "b" });
      await waitFor(() => expect(refreshMeetingModeStatus).toHaveBeenCalled());
    });

    it("Test Virtual Microphone routes the tone to the detected playback device via setSinkId", async () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: true,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: "cable-in",
          playbackDeviceName: "CABLE Input (VB-Audio Virtual Cable)",
          meetingInputName: "CABLE Output (VB-Audio Virtual Cable)",
          ready: true,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /test virtual microphone/i }));

      await waitFor(() => expect(audioContextInstances.length).toBeGreaterThan(0));
      const ctx = audioContextInstances[audioContextInstances.length - 1];
      expect(ctx.setSinkId).toHaveBeenCalledWith("cable-in");
      expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    });

    it('clicking "Setup Guide" reveals the MeetingSetupGuide content', async () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: false,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);

      expect(screen.queryByText(/Install VB-CABLE/)).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /setup guide/i }));
      expect(screen.getByText(/Install VB-CABLE/)).toBeInTheDocument();
    });

    it('"Re-check" calls refreshMeetingModeStatus', async () => {
      const refreshMeetingModeStatus = vi.fn().mockResolvedValue(null);
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: false,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus,
      });
      render(<AudioDevicesScreen />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /re-check/i }));
      expect(refreshMeetingModeStatus).toHaveBeenCalled();
    });

    it("shows an unsupported-platform message on Linux instead of device rows", () => {
      useLiveVoiceStoreMock.mockReturnValue({
        meetingModeStatus: {
          platform: "linux",
          provider: "none",
          installed: false,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: null,
          playbackDeviceName: null,
          meetingInputName: null,
          ready: false,
        },
        refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
      });
      render(<AudioDevicesScreen />);
      expect(screen.getByText(/only available on Windows and macOS/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /test virtual microphone/i })).not.toBeInTheDocument();
    });
  });
});
