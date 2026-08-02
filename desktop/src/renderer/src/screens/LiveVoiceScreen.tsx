import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Row } from "../components/Card";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import { LevelMeter } from "../components/LevelMeter";
import { useSettings } from "../hooks/useSettings";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useVoiceProfiles } from "../hooks/useVoiceProfiles";
import { useLiveVoiceStore } from "../services/singletons";
import type { OutputMode } from "@shared/types";

const STATE_TONE: Record<string, StatusTone> = {
  IDLE: "idle",
  CHECKING: "warn",
  CONNECTING: "warn",
  LOADING_VOICE: "warn",
  READY: "good",
  STARTING: "warn",
  LIVE: "good",
  STOPPING: "warn",
  ERROR: "bad",
};

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Maps a raw engine.error code / failure reason into the actionable,
 * non-technical copy Step 36 requires — never a raw Python traceback. */
function actionableErrorMessage(raw: string): string {
  if (/engine.*unavailable|engine python not found|not found/i.test(raw)) {
    return "VoiceShift AI Engine is unavailable. Start Engine or check System Check.";
  }
  if (/microphone.*denied|permission/i.test(raw)) {
    return "Microphone access was denied. Allow microphone access and try again.";
  }
  if (/not ready for ai processing/i.test(raw)) {
    return "Selected voice is not ready for AI processing.";
  }
  if (/disconnected/i.test(raw)) {
    return "Microphone was disconnected. Reconnect it and press Start Live again.";
  }
  if (/lost/i.test(raw)) {
    return "Connection to the AI engine was lost. Check System Check and try again.";
  }
  if (/no virtual audio driver/i.test(raw)) {
    return raw; // already actionable — names the exact driver and points to Audio Devices
  }
  if (/multiple virtual audio devices/i.test(raw)) {
    return raw;
  }
  if (/could not route audio/i.test(raw)) {
    return raw;
  }
  if (/virtual audio device disappeared/i.test(raw)) {
    return "Virtual audio device disappeared. Reconnect it, then Start Live again.";
  }
  return raw;
}

export function LiveVoiceScreen() {
  const store = useLiveVoiceStore();
  const { settings, update } = useSettings();
  const { inputDevices, outputDevices, permission, requestPermission } = useMediaDevices();
  const { profiles } = useVoiceProfiles();
  const readyProfiles = useMemo(() => profiles.filter((p) => p.status === "READY_FOR_AI_PROCESSING"), [profiles]);

  useEffect(() => {
    if (!settings) return;
    if (settings.voiceProfileId && !store.selectedVoiceProfileId) {
      store.setSelectedVoiceProfileId(settings.voiceProfileId);
    }
    if (settings.microphoneDeviceId && !store.selectedMicDeviceId) {
      store.setSelectedMicDeviceId(settings.microphoneDeviceId);
    }
    if (settings.outputDeviceId && !store.selectedOutputDeviceId) {
      store.setSelectedOutputDeviceId(settings.outputDeviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    if (permission === "unknown") requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settings) return;
    store.setOutputMode(settings.outputMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.outputMode]);

  useEffect(() => {
    if (store.outputMode === "meeting") store.refreshMeetingModeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.outputMode]);

  const [virtualTesting, setVirtualTesting] = useState(false);
  const [virtualTestError, setVirtualTestError] = useState<string | null>(null);
  const virtualContextRef = useRef<AudioContext | null>(null);
  const virtualTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (virtualTimeoutRef.current != null) clearTimeout(virtualTimeoutRef.current);
      virtualContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  async function testVirtualMic() {
    setVirtualTestError(null);
    const deviceId = store.meetingModeStatus?.playbackDeviceId;
    if (!deviceId) {
      setVirtualTestError("No virtual audio device detected yet — check Audio Devices.");
      return;
    }
    setVirtualTesting(true);
    try {
      const context = new AudioContext();
      virtualContextRef.current = context;
      const contextWithSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof contextWithSink.setSinkId === "function") await contextWithSink.setSinkId(deviceId);

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      oscillator.connect(gain);
      gain.connect(context.destination);
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
      gain.gain.setValueAtTime(0.2, now + 0.95);
      gain.gain.linearRampToValueAtTime(0, now + 1);
      oscillator.start(now);
      oscillator.stop(now + 1);

      virtualTimeoutRef.current = window.setTimeout(() => {
        context.close().catch(() => undefined);
        setVirtualTesting(false);
      }, 1050);
    } catch (err) {
      setVirtualTestError(err instanceof Error ? err.message : "Could not send audio to the virtual device.");
      setVirtualTesting(false);
    }
  }

  const isLive = store.state === "LIVE";
  const isBusy = ["CHECKING", "CONNECTING", "LOADING_VOICE", "STARTING", "STOPPING"].includes(store.state);
  const meetingModeReady = store.outputMode === "local" || !!store.meetingModeStatus?.ready;
  const canStart = store.state === "IDLE" && !!store.selectedVoiceProfileId && permission === "granted" && meetingModeReady;

  return (
    <div>
      <h1 className="vs-page-title">Live Voice</h1>
      <p className="vs-page-subtitle">Speak into your microphone and hear the converted target voice.</p>

      <div className="vs-banner vs-banner-warn">
        Use headphones during Live Voice testing to prevent microphone feedback.
      </div>

      {store.state === "ERROR" && store.error && (
        <div className="vs-banner vs-banner-error">{actionableErrorMessage(store.error)}</div>
      )}

      <Card title="Setup">
        <Row
          label="Target Voice"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 220 }}
              disabled={isLive || isBusy}
              value={store.selectedVoiceProfileId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                store.setSelectedVoiceProfileId(id);
                if (id) update({ voiceProfileId: id });
              }}
            >
              <option value="">Select a voice…</option>
              {readyProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="Input"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 220 }}
              disabled={isLive || isBusy}
              value={store.selectedMicDeviceId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                store.setSelectedMicDeviceId(id);
                if (id) update({ microphoneDeviceId: id });
              }}
            >
              <option value="">System default</option>
              {inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="Output"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 220 }}
              disabled={isLive || isBusy}
              value={store.selectedOutputDeviceId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                store.setSelectedOutputDeviceId(id);
                if (id) update({ outputDeviceId: id });
              }}
            >
              <option value="">System default</option>
              {outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Output device"}
                </option>
              ))}
            </select>
          }
        />
        <Row label="AI Engine" value="OpenVoice V2 / ONNX Runtime (CPU)" />
        {permission !== "granted" && (
          <Row
            label="Microphone Permission"
            value={
              <button className="vs-btn" onClick={requestPermission}>
                Grant Access
              </button>
            }
          />
        )}
        <Row
          label="Output Mode"
          value={
            <div style={{ display: "flex", gap: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="output-mode"
                  disabled={isLive || isBusy}
                  checked={store.outputMode === "local"}
                  onChange={() => {
                    store.setOutputMode("local" as OutputMode);
                    update({ outputMode: "local" });
                  }}
                />
                Local Test
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="output-mode"
                  disabled={isLive || isBusy}
                  checked={store.outputMode === "meeting"}
                  onChange={() => {
                    store.setOutputMode("meeting" as OutputMode);
                    update({ outputMode: "meeting" });
                  }}
                />
                Meeting Mode
              </label>
            </div>
          }
        />

        {store.outputMode === "meeting" && (
          <>
            <Row
              label="Virtual Microphone"
              value={
                <StatusBadge
                  tone={
                    !store.meetingModeStatus
                      ? "warn"
                      : store.meetingModeStatus.ready
                        ? "good"
                        : store.meetingModeStatus.installed
                          ? "warn"
                          : "bad"
                  }
                  label={
                    !store.meetingModeStatus
                      ? "Checking…"
                      : store.meetingModeStatus.ready
                        ? (store.meetingModeStatus.provider === "vb-cable" ? "VB-CABLE" : "BlackHole")
                        : store.meetingModeStatus.installed
                          ? "Ambiguous"
                          : "Not Installed"
                  }
                />
              }
            />
            <Row
              label="Status"
              value={store.meetingModeStatus?.ready ? "READY FOR MEETING" : "NOT READY — check Audio Devices"}
            />
            {virtualTestError && <div className="vs-banner vs-banner-error">{virtualTestError}</div>}
            <div style={{ marginTop: 8 }}>
              <button
                className="vs-btn"
                disabled={virtualTesting || !store.meetingModeStatus?.ready}
                onClick={testVirtualMic}
              >
                {virtualTesting ? "Sending…" : "Test Virtual Mic"}
              </button>
            </div>
          </>
        )}
      </Card>

      <Card
        title="Status"
        action={
          isLive ? (
            <span className="vs-live-indicator">
              <span className="vs-live-dot" /> LIVE
              {store.outputMode === "meeting" && " — VIRTUAL MICROPHONE ACTIVE"} {formatDuration(store.metrics.sessionDurationSec)}
            </span>
          ) : (
            <StatusBadge tone={STATE_TONE[store.state] ?? "idle"} label={store.state} />
          )
        }
      >
        <LevelMeter label="Input" level={store.metrics.inputLevel} />
        <div style={{ height: 8 }} />
        <LevelMeter label="Output" level={store.metrics.outputLevel} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16 }}>
          <Metric
            label="Latency (capture→received)"
            value={store.metrics.processingLatencyMs != null ? `${Math.round(store.metrics.processingLatencyMs)} ms` : "—"}
          />
          <Metric label="RTF (est.)" value={store.metrics.rtf != null ? store.metrics.rtf.toFixed(2) : "—"} />
          <Metric label="Queue (in-flight)" value={String(store.metrics.queueDepth)} />
          <Metric label="Rejected" value={String(store.metrics.rejectedFrames)} />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          {!isLive ? (
            <>
              <button className="vs-btn" disabled={!canStart} onClick={() => store.testVoice()}>
                Test Voice
              </button>
              <button className="vs-btn vs-btn-primary" disabled={!canStart} onClick={() => store.startLive()}>
                {isBusy ? "Starting…" : "Start Live"}
              </button>
            </>
          ) : (
            <button className="vs-btn vs-btn-danger" onClick={() => store.stopLive()}>
              Stop
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 650 }}>{value}</div>
    </div>
  );
}
