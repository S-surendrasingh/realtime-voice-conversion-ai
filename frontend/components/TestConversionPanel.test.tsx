import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversionResult, VoiceProfile } from "@/types/voice";
import { TestConversionPanel } from "./TestConversionPanel";

const { convertVoiceMock, conversionAudioUrlMock } = vi.hoisted(() => ({
  convertVoiceMock: vi.fn(),
  conversionAudioUrlMock: vi.fn(
    (profileId: string, conversionId: string) => `http://api.test/${profileId}/${conversionId}`
  ),
}));

vi.mock("@/lib/api", () => ({
  convertVoice: convertVoiceMock,
  conversionAudioUrl: conversionAudioUrlMock,
}));

const PROFILE: VoiceProfile = {
  id: "profile-1",
  name: "surendra 1",
  description: null,
  status: "READY_FOR_AI_PROCESSING",
  consent_confirmed: true,
  consent_confirmed_at: "2026-08-25T00:00:00Z",
  created_at: "2026-08-25T00:00:00Z",
  updated_at: "2026-08-25T00:00:00Z",
  sample_count: 3,
  valid_sample_count: 3,
  total_duration_seconds: 42,
};

const RESULT: ConversionResult = {
  conversion_id: "conv-1",
  voice_profile_id: "profile-1",
  status: "completed",
  source_duration_seconds: 8.42,
  processing_time_seconds: 5.11,
  rtf: 0.607,
  model: "seed-uvit-tat-xlsr-tiny",
  device: "cpu",
  output_url: "/api/v1/voices/profile-1/conversions/conv-1/audio",
};

function selectFile() {
  const input = screen.getByLabelText("Upload Person B Audio") as HTMLInputElement;
  const file = new File(["fake-audio-bytes"], "person_b.wav", { type: "audio/wav" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  convertVoiceMock.mockReset();
  conversionAudioUrlMock.mockClear();
  // jsdom doesn't implement createObjectURL/revokeObjectURL.
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

describe("TestConversionPanel", () => {
  it("shows the target voice name", () => {
    render(<TestConversionPanel profile={PROFILE} />);
    expect(screen.getByText("surendra 1")).toBeInTheDocument();
  });

  it("disables Convert until a file is selected", () => {
    render(<TestConversionPanel profile={PROFILE} />);
    expect(screen.getByRole("button", { name: "Convert to Target Voice" })).toBeDisabled();
  });

  it("enables Convert and shows a source player once a file is selected", () => {
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();

    expect(screen.getByRole("button", { name: "Convert to Target Voice" })).toBeEnabled();
    expect(screen.getByText("Source")).toBeInTheDocument();
  });

  it("shows a loading state while converting", async () => {
    let resolveConvert: (value: ConversionResult) => void = () => {};
    convertVoiceMock.mockReturnValue(new Promise((resolve) => (resolveConvert = resolve)));
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));

    expect(await screen.findByRole("button", { name: "Processing..." })).toBeDisabled();
    resolveConvert(RESULT);
    await waitFor(() => expect(screen.getByRole("button", { name: "Convert to Target Voice" })).toBeEnabled());
  });

  it("shows the converted audio player and measured metrics on success", async () => {
    convertVoiceMock.mockResolvedValue(RESULT);
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));

    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(screen.getByText("8.4 sec")).toBeInTheDocument();
    expect(screen.getByText("5.1 sec")).toBeInTheDocument();
    expect(screen.getByText("0.61")).toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("seed-uvit-tat-xlsr-tiny")).toBeInTheDocument();
    expect(conversionAudioUrlMock).toHaveBeenCalledWith("profile-1", "conv-1");
  });

  it("renders the RTF value rounded to two decimal places", async () => {
    convertVoiceMock.mockResolvedValue({ ...RESULT, rtf: 1.23456 });
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));

    expect(await screen.findByText("1.23")).toBeInTheDocument();
  });

  it("shows an error message when the API call fails", async () => {
    convertVoiceMock.mockRejectedValue(new Error("Voice profile is not READY_FOR_AI_PROCESSING yet."));
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));

    expect(await screen.findByText("Voice profile is not READY_FOR_AI_PROCESSING yet.")).toBeInTheDocument();
  });

  it("clears a previous result when a new file is selected", async () => {
    convertVoiceMock.mockResolvedValue(RESULT);
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));
    await screen.findByText("Result");

    selectFile();

    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("surfaces a clear message when the AI worker isn't configured", async () => {
    convertVoiceMock.mockRejectedValue(
      new Error("AI worker interpreter not found (has ai-worker/.venv been set up?)")
    );
    render(<TestConversionPanel profile={PROFILE} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: "Convert to Target Voice" }));

    expect(await screen.findByText(/ai worker interpreter not found/i)).toBeInTheDocument();
  });

  it("always shows the AI-generated-audio disclaimer", () => {
    render(<TestConversionPanel profile={PROFILE} />);
    expect(screen.getByText(/AI-generated/i)).toBeInTheDocument();
  });
});
