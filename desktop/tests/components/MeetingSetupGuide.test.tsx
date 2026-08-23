import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MeetingSetupGuide } from "@renderer/components/MeetingSetupGuide";
import type { VirtualDeviceStatus } from "@shared/virtualAudio";

const READY_WINDOWS_STATUS: VirtualDeviceStatus = {
  platform: "win32",
  provider: "vb-cable",
  installed: true,
  ambiguous: false,
  candidates: [],
  playbackDeviceId: "cable-in",
  playbackDeviceName: "CABLE Input (VB-Audio Virtual Cable)",
  meetingInputName: "CABLE Output (VB-Audio Virtual Cable)",
  ready: true,
};

describe("MeetingSetupGuide", () => {
  it("shows install instructions for Windows referencing VB-CABLE, not bundled", () => {
    render(<MeetingSetupGuide platform="win32" status={null} />);
    expect(screen.getByText(/Install VB-CABLE/)).toBeInTheDocument();
    expect(screen.getByText(/not bundled with VoiceShift/)).toBeInTheDocument();
  });

  it("shows install instructions for macOS referencing BlackHole", () => {
    render(<MeetingSetupGuide platform="darwin" status={null} />);
    expect(screen.getByText(/Install BlackHole/)).toBeInTheDocument();
  });

  it("does not render meeting-app guides when no device has been detected yet", () => {
    render(<MeetingSetupGuide platform="win32" status={null} />);
    expect(screen.queryByText("Google Meet")).not.toBeInTheDocument();
  });

  it("renders all three meeting-app guides once a device is ready, using the real meeting mic name", () => {
    render(<MeetingSetupGuide platform="win32" status={READY_WINDOWS_STATUS} />);
    expect(screen.getByText("Google Meet")).toBeInTheDocument();
    expect(screen.getByText("Microsoft Teams")).toBeInTheDocument();
    expect(screen.getByText("Slack Huddle")).toBeInTheDocument();
    expect(screen.getAllByText(/CABLE Output \(VB-Audio Virtual Cable\)/).length).toBeGreaterThan(0);
  });

  it("explicitly states this is guide-only, no API integration", () => {
    render(<MeetingSetupGuide platform="win32" status={READY_WINDOWS_STATUS} />);
    expect(screen.getByText(/does not integrate with any meeting app directly/)).toBeInTheDocument();
  });

  it("shows nothing meaningful for an unsupported platform (Linux dev)", () => {
    render(<MeetingSetupGuide platform="linux" status={null} />);
    expect(screen.getByText(/not available on this platform/i)).toBeInTheDocument();
  });
});
