import type { AppPlatform } from "@shared/types";
import type { VirtualDeviceStatus } from "@shared/virtualAudio";
import { getVirtualAudioIntegration } from "../audio/virtualAudioAdapters";

interface MeetingAppGuide {
  app: string;
  steps: (micName: string) => string[];
}

/** Guide-only content (Steps 25-27) — VoiceShift does not integrate with
 * any of these apps' APIs. Each guide just tells the user which OS-level
 * device to pick; the meeting app treats it exactly like a normal
 * microphone. */
const MEETING_APP_GUIDES: MeetingAppGuide[] = [
  {
    app: "Google Meet",
    steps: (mic) => [
      "Open Google Meet's audio settings (gear icon, or during a call).",
      `Set Microphone to "${mic}".`,
      "Keep Speakers on your normal headphones/speakers.",
      'Run VoiceShift "Test Virtual Microphone" below.',
      "Verify Meet's microphone level indicator responds while the test plays.",
      "Start VoiceShift Live in Meeting Mode.",
    ],
  },
  {
    app: "Microsoft Teams",
    steps: (mic) => [
      "Open Teams' device settings (Settings > Devices).",
      `Set Microphone to "${mic}".`,
      "Keep Speaker on your normal headphones/speakers.",
      'Run VoiceShift "Test Virtual Microphone" and confirm Teams shows mic activity.',
      "Start VoiceShift Live in Meeting Mode.",
    ],
  },
  {
    app: "Slack Huddle",
    steps: (mic) => [
      "Open Huddle audio settings (or Slack's Preferences > Audio & Video).",
      `Choose "${mic}" as the microphone.`,
      "Keep your normal speakers/headphones as the output.",
      `Run VoiceShift "Test Virtual Microphone" and confirm the huddle's mic indicator responds.`,
      "Start VoiceShift Live in Meeting Mode.",
    ],
  },
];

export function MeetingSetupGuide({
  platform,
  status,
}: {
  platform: AppPlatform;
  status: VirtualDeviceStatus | null;
}) {
  const integration = getVirtualAudioIntegration(platform);
  const instructions = integration.getSetupInstructions();
  const meetingMicName = status?.meetingInputName ?? null;

  return (
    <div>
      <h4 style={{ margin: "0 0 6px" }}>{instructions.title}</h4>
      {instructions.downloadHint && (
        <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 8px" }}>{instructions.downloadHint}</p>
      )}
      {instructions.steps.length > 0 && (
        <ol style={{ margin: "0 0 16px", paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
          {instructions.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}

      {meetingMicName && (
        <>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 10 }}>
            VoiceShift sends converted audio to a standard OS virtual audio device — it does not integrate with any
            meeting app directly. Select the matching device as the microphone in each app below, exactly as you
            would select any other microphone.
          </p>
          {MEETING_APP_GUIDES.map(({ app, steps }) => (
            <div key={app} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{app}</div>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                {steps(meetingMicName).map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
