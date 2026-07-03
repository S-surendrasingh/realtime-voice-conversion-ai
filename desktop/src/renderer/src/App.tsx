import { useState } from "react";
import { SystemCheckScreen } from "./screens/SystemCheckScreen";
import { VoiceProfilesScreen } from "./screens/VoiceProfilesScreen";
import { LiveVoiceScreen } from "./screens/LiveVoiceScreen";
import { AudioDevicesScreen } from "./screens/AudioDevicesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

const SCREENS = [
  { id: "system-check", label: "System Check", Component: SystemCheckScreen },
  { id: "voice-profiles", label: "Voice Profiles", Component: VoiceProfilesScreen },
  { id: "live-voice", label: "Live Voice", Component: LiveVoiceScreen },
  { id: "audio-devices", label: "Audio Devices", Component: AudioDevicesScreen },
  { id: "settings", label: "Settings", Component: SettingsScreen },
] as const;

type ScreenId = (typeof SCREENS)[number]["id"];

export function App() {
  const [active, setActive] = useState<ScreenId>("live-voice");
  const ActiveComponent = SCREENS.find((s) => s.id === active)?.Component ?? LiveVoiceScreen;

  return (
    <div className="vs-app-shell">
      <nav className="vs-nav">
        <div className="vs-nav-brand">
          Voice<span>Shift</span> AI
        </div>
        {SCREENS.map((screen) => (
          <button
            key={screen.id}
            className={`vs-nav-item${active === screen.id ? " active" : ""}`}
            onClick={() => setActive(screen.id)}
          >
            {screen.label}
          </button>
        ))}
      </nav>
      <main className="vs-main">
        <ActiveComponent />
      </main>
    </div>
  );
}
