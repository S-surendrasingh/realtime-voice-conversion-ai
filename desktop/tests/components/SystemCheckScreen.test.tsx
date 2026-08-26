import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EngineProcessStatus } from "@shared/types";
import type { MicPermissionState } from "@renderer/hooks/useMediaDevices";

const useEngineStatusMock = vi.fn();
vi.mock("@renderer/hooks/useEngineStatus", () => ({
  useEngineStatus: () => useEngineStatusMock(),
}));

const useMediaDevicesMock = vi.fn();
vi.mock("@renderer/hooks/useMediaDevices", () => ({
  useMediaDevices: () => useMediaDevicesMock(),
}));

const getBackendClientMock = vi.fn();
const useLiveVoiceStoreMock = vi.fn();
vi.mock("@renderer/services/singletons", () => ({
  getBackendClient: () => getBackendClientMock(),
  useLiveVoiceStore: () => useLiveVoiceStoreMock(),
}));

const READY_STATUS: EngineProcessStatus = {
  mode: "managed",
  running: true,
  ready: true,
  pid: 4242,
  startedAt: Date.now(),
  lastError: null,
  restartCount: 0,
};

const NOT_READY_STATUS: EngineProcessStatus = {
  mode: "managed",
  running: false,
  ready: false,
  pid: null,
  startedAt: null,
  lastError: "Engine python not found",
  restartCount: 1,
};

function fakeDevice(kind: MediaDeviceInfo["kind"], id: string): MediaDeviceInfo {
  return {
    deviceId: id,
    kind,
    label: `${kind}-${id}`,
    groupId: "g1",
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

function makeEngineStatus(overrides: Partial<ReturnType<typeof baseEngineStatus>> = {}) {
  return { ...baseEngineStatus(), ...overrides };
}

function baseEngineStatus() {
  return {
    status: READY_STATUS,
    logs: [],
    start: vi.fn().mockResolvedValue(READY_STATUS),
    restart: vi.fn().mockResolvedValue(READY_STATUS),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function makeMediaDevices(overrides: Partial<ReturnType<typeof baseMediaDevices>> = {}) {
  return { ...baseMediaDevices(), ...overrides };
}

function baseMediaDevices() {
  return {
    inputDevices: [fakeDevice("audioinput", "mic-1")],
    outputDevices: [fakeDevice("audiooutput", "spk-1"), fakeDevice("audiooutput", "spk-2")],
    permission: "granted" as MicPermissionState,
    requestPermission: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBackendClient(available: boolean) {
  return { checkAvailable: vi.fn().mockResolvedValue(available) };
}

function makeLiveVoiceStore(overrides: Partial<ReturnType<typeof baseLiveVoiceStore>> = {}) {
  return { ...baseLiveVoiceStore(), ...overrides };
}

function baseLiveVoiceStore() {
  return {
    meetingModeStatus: null as null | Record<string, unknown>,
    refreshMeetingModeStatus: vi.fn().mockResolvedValue(null),
  };
}

function setPlatformInfo(overrides: Partial<{ name: string; supportsVirtualAudioOutput: boolean; virtualOutputDeviceHints: string[] }> = {}) {
  const getInfo = vi.fn().mockResolvedValue({
    name: "linux-dev",
    supportsVirtualAudioOutput: false,
    virtualOutputDeviceHints: [],
    ...overrides,
  });
  // No real Electron preload exists in jsdom, so stub the bridge directly —
  // only platform.getInfo is exercised by this screen; engine.* calls go
  // through the mocked useEngineStatus hook instead.
  (window as unknown as { voiceshift: Record<string, unknown> }).voiceshift = {
    platform: { getInfo },
    engine: {},
  };
  return getInfo;
}

async function importScreen() {
  const mod = await import("@renderer/screens/SystemCheckScreen");
  return mod.SystemCheckScreen;
}

describe("SystemCheckScreen", () => {
  beforeEach(() => {
    useEngineStatusMock.mockReset();
    useMediaDevicesMock.mockReset();
    getBackendClientMock.mockReset();
    useLiveVoiceStoreMock.mockReset();
    useLiveVoiceStoreMock.mockReturnValue(makeLiveVoiceStore());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows every check as good when everything is genuinely healthy", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus());
    useMediaDevicesMock.mockReturnValue(makeMediaDevices());
    getBackendClientMock.mockResolvedValue(makeBackendClient(true));
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
    expect(screen.getByText("Available")).toBeInTheDocument(); // backend
    expect(screen.getByText("Available (1)")).toBeInTheDocument(); // microphone
    expect(screen.getByText("Available (2)")).toBeInTheDocument(); // output
    expect(screen.getByText(/CPU \(linux-dev\)/)).toBeInTheDocument();
    expect(screen.queryByText("Start Engine")).not.toBeInTheDocument();
  });

  it("shows the engine as not ready and surfaces the last error", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus({ status: NOT_READY_STATUS }));
    useMediaDevicesMock.mockReturnValue(makeMediaDevices());
    getBackendClientMock.mockResolvedValue(makeBackendClient(true));
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Not Ready")).toBeInTheDocument());
    expect(screen.getByText("Engine python not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Engine" })).toBeInTheDocument();
  });

  it("shows the backend as unavailable when checkAvailable resolves false", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus());
    useMediaDevicesMock.mockReturnValue(makeMediaDevices());
    getBackendClientMock.mockResolvedValue(makeBackendClient(false));
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Unavailable")).toBeInTheDocument());
  });

  it("never claims the microphone is available when permission is denied", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus());
    useMediaDevicesMock.mockReturnValue(
      makeMediaDevices({ permission: "denied", inputDevices: [fakeDevice("audioinput", "mic-1")] })
    );
    getBackendClientMock.mockResolvedValue(makeBackendClient(true));
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Permission Denied")).toBeInTheDocument());
  });

  it("re-runs every check when Run System Check is clicked", async () => {
    const engineStatus = makeEngineStatus();
    const mediaDevices = makeMediaDevices();
    const backendClient = makeBackendClient(true);
    const liveVoiceStore = makeLiveVoiceStore();
    useEngineStatusMock.mockReturnValue(engineStatus);
    useMediaDevicesMock.mockReturnValue(mediaDevices);
    getBackendClientMock.mockResolvedValue(backendClient);
    useLiveVoiceStoreMock.mockReturnValue(liveVoiceStore);
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());

    engineStatus.healthCheck.mockClear();
    mediaDevices.refresh.mockClear();
    backendClient.checkAvailable.mockClear();
    liveVoiceStore.refreshMeetingModeStatus.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Run System Check/ }));

    await waitFor(() => {
      expect(engineStatus.healthCheck).toHaveBeenCalledTimes(1);
      expect(mediaDevices.refresh).toHaveBeenCalledTimes(1);
      expect(backendClient.checkAvailable).toHaveBeenCalledTimes(1);
      expect(liveVoiceStore.refreshMeetingModeStatus).toHaveBeenCalledTimes(1);
    });
  });

  it("shows real virtual-audio-driver and Meeting Mode state, never green just because the engine is ready", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus());
    useMediaDevicesMock.mockReturnValue(makeMediaDevices());
    getBackendClientMock.mockResolvedValue(makeBackendClient(true));
    useLiveVoiceStoreMock.mockReturnValue(
      makeLiveVoiceStore({
        meetingModeStatus: {
          platform: "win32",
          provider: "vb-cable",
          installed: true,
          ambiguous: false,
          candidates: [],
          playbackDeviceId: "cable-in",
          playbackDeviceName: "CABLE Input",
          meetingInputName: "CABLE Output",
          ready: true,
        },
      })
    );
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Installed")).toBeInTheDocument());
    expect(screen.getByText("CABLE Input")).toBeInTheDocument();
    expect(screen.getByText("CABLE Output")).toBeInTheDocument();
    // Two "Ready" badges expected: AI Engine and Meeting Mode — both real,
    // independently computed, not one implying the other.
    expect(screen.getAllByText("Ready").length).toBe(2);
  });

  it("shows Meeting Mode as Not Ready when the driver isn't installed, even though the engine is Ready", async () => {
    useEngineStatusMock.mockReturnValue(makeEngineStatus());
    useMediaDevicesMock.mockReturnValue(makeMediaDevices());
    getBackendClientMock.mockResolvedValue(makeBackendClient(true));
    useLiveVoiceStoreMock.mockReturnValue(
      makeLiveVoiceStore({
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
      })
    );
    setPlatformInfo();

    const SystemCheckScreen = await importScreen();
    render(<SystemCheckScreen />);

    await waitFor(() => expect(screen.getByText("Not Installed")).toBeInTheDocument());
    expect(screen.getByText("Not Ready")).toBeInTheDocument();
    // AI Engine itself is still genuinely Ready — the two must not be conflated.
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
