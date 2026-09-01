import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceProfilesScreen } from "@renderer/screens/VoiceProfilesScreen";
import { useVoiceProfiles } from "@renderer/hooks/useVoiceProfiles";
import { useSettings } from "@renderer/hooks/useSettings";
import { useLiveVoiceStore } from "@renderer/services/singletons";
import type { VoiceProfile } from "@renderer/services/BackendClient";

vi.mock("@renderer/hooks/useVoiceProfiles");
vi.mock("@renderer/hooks/useSettings");
vi.mock("@renderer/services/singletons", () => ({
  useLiveVoiceStore: vi.fn(),
}));

const mockUseVoiceProfiles = vi.mocked(useVoiceProfiles);
const mockUseSettings = vi.mocked(useSettings);
const mockUseLiveVoiceStore = vi.mocked(useLiveVoiceStore);

const READY_PROFILE: VoiceProfile = {
  id: "voice-ready-1",
  name: "Ready Voice",
  description: "A finished profile",
  status: "READY_FOR_AI_PROCESSING",
  consent_confirmed: true,
  consent_confirmed_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  sample_count: 4,
  valid_sample_count: 3,
  total_duration_seconds: 120,
};

const RECORDING_PROFILE: VoiceProfile = {
  id: "voice-recording-1",
  name: "In Progress Voice",
  description: null,
  status: "RECORDING",
  consent_confirmed: false,
  consent_confirmed_at: null,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  sample_count: 1,
  valid_sample_count: 0,
  total_duration_seconds: 10,
};

const PROCESSING_PROFILE: VoiceProfile = {
  id: "voice-processing-1",
  name: "Processing Voice",
  description: null,
  status: "PROCESSING",
  consent_confirmed: true,
  consent_confirmed_at: "2026-01-03T00:00:00Z",
  created_at: "2026-01-03T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  sample_count: 5,
  valid_sample_count: 5,
  total_duration_seconds: 200,
};

function mockVoiceProfiles(overrides: Partial<ReturnType<typeof useVoiceProfiles>> = {}) {
  mockUseVoiceProfiles.mockReturnValue({
    profiles: [],
    loading: false,
    error: null,
    backendUnavailable: false,
    refresh: vi.fn(),
    ...overrides,
  });
}

const setSelectedVoiceProfileId = vi.fn();
const updateSettings = vi.fn();

function mockStore(selectedVoiceProfileId: string | null = null) {
  mockUseLiveVoiceStore.mockReturnValue({
    selectedVoiceProfileId,
    setSelectedVoiceProfileId,
  } as unknown as ReturnType<typeof useLiveVoiceStore>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSettings.mockReturnValue({
    settings: null,
    update: updateSettings,
  } as unknown as ReturnType<typeof useSettings>);
  mockStore(null);
});

describe("VoiceProfilesScreen", () => {
  it("renders a mix of ready and not-ready profiles with the right badges", () => {
    mockVoiceProfiles({ profiles: [READY_PROFILE, RECORDING_PROFILE, PROCESSING_PROFILE] });

    render(<VoiceProfilesScreen />);

    expect(screen.getByText("Ready Voice")).toBeInTheDocument();
    expect(screen.getByText("READY FOR AI")).toBeInTheDocument();
    expect(screen.getByText("3 valid samples")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use This Voice" })).toBeInTheDocument();

    expect(screen.getByText("In Progress Voice")).toBeInTheDocument();
    expect(screen.getByText("Not ready yet — status: RECORDING")).toBeInTheDocument();

    expect(screen.getByText("Processing Voice")).toBeInTheDocument();
    expect(screen.getByText("Not ready yet — status: PROCESSING")).toBeInTheDocument();

    // Only the ready profile gets a "Use This Voice" button.
    expect(screen.getAllByRole("button", { name: "Use This Voice" })).toHaveLength(1);
  });

  it("highlights the currently selected profile", () => {
    mockVoiceProfiles({ profiles: [READY_PROFILE] });
    mockStore(READY_PROFILE.id);

    render(<VoiceProfilesScreen />);

    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("calls setSelectedVoiceProfileId and update() with the profile id when Use This Voice is clicked", async () => {
    const user = userEvent.setup();
    mockVoiceProfiles({ profiles: [READY_PROFILE] });

    render(<VoiceProfilesScreen />);

    await user.click(screen.getByRole("button", { name: "Use This Voice" }));

    expect(setSelectedVoiceProfileId).toHaveBeenCalledWith(READY_PROFILE.id);
    expect(updateSettings).toHaveBeenCalledWith({ voiceProfileId: READY_PROFILE.id });
  });

  it("shows a loading indicator instead of an empty list while loading", () => {
    mockVoiceProfiles({ loading: true });

    render(<VoiceProfilesScreen />);

    expect(screen.getByText(/loading voice profiles/i)).toBeInTheDocument();
    expect(screen.queryByText(/no voice profiles yet/i)).not.toBeInTheDocument();
  });

  it("shows a backend-unavailable message with a working Retry button", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    mockVoiceProfiles({ backendUnavailable: true, refresh });

    render(<VoiceProfilesScreen />);

    expect(screen.getByText(/backend unavailable/i)).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    await user.click(retryButton);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the error message when the hook reports an error", () => {
    mockVoiceProfiles({ error: "Something went wrong" });

    render(<VoiceProfilesScreen />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no profiles at all", () => {
    mockVoiceProfiles({ profiles: [] });

    render(<VoiceProfilesScreen />);

    expect(screen.getByText(/no voice profiles yet\. enroll one via the web app\./i)).toBeInTheDocument();
  });
});
