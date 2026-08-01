import { useEffect, useRef, useState } from "react";
import { Card, Row } from "../components/Card";
import { LevelMeter } from "../components/LevelMeter";
import { MeetingSetupGuide } from "../components/MeetingSetupGuide";
import { StatusBadge } from "../components/StatusBadge";
import { useMediaDevices, type MicPermissionState } from "../hooks/useMediaDevices";
import { useSettings } from "../hooks/useSettings";
import { useLiveVoiceStore } from "../services/singletons";
import { getVirtualAudioIntegration } from "../audio/virtualAudioAdapters";

/** Auto-stop a running mic test after this long, so a forgotten test never
 * leaves the microphone open indefinitely ("no invisible mic capture"). */
const MIC_TEST_MAX_DURATION_MS = 10_000;
/** ~10Hz level-meter refresh, per the product spec for this screen. */
const MIC_POLL_INTERVAL_MS = 100;
/** Length of the audible output test tone, in seconds. */
const OUTPUT_TEST_DURATION_S = 1;

function permissionLabel(permission: MicPermissionState): string {
  switch (permission) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "no-device":
      return "No microphone detected";
    default:
      return "Not requested yet";
  }
}

function permissionColor(permission: MicPermissionState): string {
  if (permission === "granted") return "var(--status-good)";
  if (permission === "denied") return "var(--status-bad)";
  return "var(--status-warn)";
}

/** Raw per-block RMS of a time-domain buffer, 0..1 for normal PCM in
 * [-1, 1]. Mirrors the formula MicCapture uses for its own level meter, so
 * a reading here means the same thing it does on Live Voice. */
function rms(buffer: Float32Array): number {
  if (buffer.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
  return Math.sqrt(sumSquares / buffer.length);
}

/** Dedicated device-management/testing screen (separate from Live Voice's
 * own inline selectors): pick an input/output device, confirm microphone
 * permission, and run a short live level test or an audible output tone —
 * all built directly on top of plain Web Audio APIs rather than the
 * streaming-oriented MicCapture pipeline, since nothing here needs
 * chunking, resampling, or the engine connection. */
export function AudioDevicesScreen() {
  const { inputDevices, outputDevices, permission, requestPermission } = useMediaDevices();
  const { settings, update } = useSettings();
  const { meetingModeStatus, refreshMeetingModeStatus } = useLiveVoiceStore();

  const [selectedInputId, setSelectedInputId] = useState<string | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);

  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const [outputTesting, setOutputTesting] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);

  const [virtualTesting, setVirtualTesting] = useState(false);
  const [virtualTestError, setVirtualTestError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micIntervalRef = useRef<number | null>(null);
  const micTimeoutRef = useRef<number | null>(null);

  const outputContextRef = useRef<AudioContext | null>(null);
  const outputTimeoutRef = useRef<number | null>(null);

  const virtualContextRef = useRef<AudioContext | null>(null);
  const virtualTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    refreshMeetingModeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize selects from persisted settings once they load, without
  // clobbering a choice the user already made in this session.
  useEffect(() => {
    if (!settings) return;
    if (settings.microphoneDeviceId && !selectedInputId) setSelectedInputId(settings.microphoneDeviceId);
    if (settings.outputDeviceId && !selectedOutputId) setSelectedOutputId(settings.outputDeviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function stopMicTest() {
    if (micIntervalRef.current != null) {
      clearInterval(micIntervalRef.current);
      micIntervalRef.current = null;
    }
    if (micTimeoutRef.current != null) {
      clearTimeout(micTimeoutRef.current);
      micTimeoutRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close().catch(() => undefined);
      micContextRef.current = null;
    }
    setMicTesting(false);
    setMicLevel(0);
  }

  function stopOutputTest() {
    if (outputTimeoutRef.current != null) {
      clearTimeout(outputTimeoutRef.current);
      outputTimeoutRef.current = null;
    }
    if (outputContextRef.current) {
      outputContextRef.current.close().catch(() => undefined);
      outputContextRef.current = null;
    }
    setOutputTesting(false);
  }

  function stopVirtualTest() {
    if (virtualTimeoutRef.current != null) {
      clearTimeout(virtualTimeoutRef.current);
      virtualTimeoutRef.current = null;
    }
    if (virtualContextRef.current) {
      virtualContextRef.current.close().catch(() => undefined);
      virtualContextRef.current = null;
    }
    setVirtualTesting(false);
  }

  // Fully tear down any open mic stream / AudioContext / timers on unmount
  // — never leave an invisible, still-open microphone capture behind.
  useEffect(() => {
    return () => {
      stopMicTest();
      stopOutputTest();
      stopVirtualTest();
    };
  }, []);

  async function startMicTest() {
    setMicError(null);
    setSampleRate(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedInputId ? { deviceId: { exact: selectedInputId } } : true,
      });
      micStreamRef.current = stream;

      const track = stream.getAudioTracks()[0];
      const trackRate = track ? track.getSettings().sampleRate : undefined;
      setSampleRate(typeof trackRate === "number" ? trackRate : null);

      const context = new AudioContext();
      micContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      micIntervalRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        setMicLevel(rms(buffer));
      }, MIC_POLL_INTERVAL_MS);

      micTimeoutRef.current = window.setTimeout(() => {
        stopMicTest();
      }, MIC_TEST_MAX_DURATION_MS);

      setMicTesting(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Could not access the microphone.");
      stopMicTest();
    }
  }

  async function testOutput() {
    setOutputError(null);
    stopOutputTest();
    setOutputTesting(true);
    try {
      const context = new AudioContext();
      outputContextRef.current = context;

      const contextWithSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (selectedOutputId && typeof contextWithSink.setSinkId === "function") {
        await contextWithSink.setSinkId(selectedOutputId);
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      oscillator.connect(gain);
      gain.connect(context.destination);

      // Brief fade in/out so the tone doesn't click at the start/end.
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
      gain.gain.setValueAtTime(0.25, now + OUTPUT_TEST_DURATION_S - 0.05);
      gain.gain.linearRampToValueAtTime(0, now + OUTPUT_TEST_DURATION_S);

      oscillator.start(now);
      oscillator.stop(now + OUTPUT_TEST_DURATION_S);

      outputTimeoutRef.current = window.setTimeout(() => {
        stopOutputTest();
      }, OUTPUT_TEST_DURATION_S * 1000 + 50);
    } catch (err) {
      setOutputError(err instanceof Error ? err.message : "Could not play the test tone.");
      stopOutputTest();
    }
  }

  /** Proves VoiceShift can send audio INTO the virtual device (Step 22) —
   * a short, safe-level test tone, not a loud alert. There is no reliable
   * cross-platform way to verify the signal reached the RECORDING side
   * from inside VoiceShift itself without brittle low-level code (Step
   * 23), so this is guided manual verification: the user checks the OS
   * input meter or their meeting app's own mic test after running this. */
  async function testVirtualMicrophone() {
    setVirtualTestError(null);
    if (!meetingModeStatus?.playbackDeviceId) {
      setVirtualTestError("No virtual audio device detected yet — check Setup Guide below.");
      return;
    }
    stopVirtualTest();
    setVirtualTesting(true);
    try {
      const context = new AudioContext();
      virtualContextRef.current = context;

      const contextWithSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof contextWithSink.setSinkId !== "function") {
        throw new Error("This browser/Electron build does not support selecting an output device.");
      }
      await contextWithSink.setSinkId(meetingModeStatus.playbackDeviceId);

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      oscillator.connect(gain);
      gain.connect(context.destination);

      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
      gain.gain.setValueAtTime(0.2, now + OUTPUT_TEST_DURATION_S - 0.05);
      gain.gain.linearRampToValueAtTime(0, now + OUTPUT_TEST_DURATION_S);

      oscillator.start(now);
      oscillator.stop(now + OUTPUT_TEST_DURATION_S);

      virtualTimeoutRef.current = window.setTimeout(() => {
        stopVirtualTest();
      }, OUTPUT_TEST_DURATION_S * 1000 + 50);
    } catch (err) {
      setVirtualTestError(err instanceof Error ? err.message : "Could not send audio to the virtual device.");
      stopVirtualTest();
    }
  }

  return (
    <div>
      <h1 className="vs-page-title">Audio Devices</h1>
      <p className="vs-page-subtitle">
        Choose and test the microphone and speaker/headphone output used across VoiceShift AI.
      </p>

      {permission === "denied" && (
        <div className="vs-banner vs-banner-error">
          Microphone access was denied. Allow microphone access in your system/browser settings, then grant access
          again below.
        </div>
      )}
      {permission === "no-device" && (
        <div className="vs-banner vs-banner-warn">No microphone was detected. Connect one and try again.</div>
      )}

      <Card title="Devices">
        <Row
          label="Input Microphone"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 260 }}
              value={selectedInputId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                setSelectedInputId(id);
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
          label="Output Device"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 260 }}
              value={selectedOutputId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                setSelectedOutputId(id);
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
        <Row
          label="Microphone Permission"
          value={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: permissionColor(permission), fontWeight: 600 }}>
                {permissionLabel(permission)}
              </span>
              {permission !== "granted" && (
                <button className="vs-btn" onClick={requestPermission}>
                  Grant Microphone Access
                </button>
              )}
            </div>
          }
        />
      </Card>

      <Card title="Microphone Test">
        <LevelMeter label="Input" level={micLevel} />
        <div style={{ height: 8 }} />
        <Row label="Sample Rate" value={sampleRate != null ? `${sampleRate} Hz` : "—"} />

        {micError && (
          <div className="vs-banner vs-banner-error" style={{ marginTop: 12, marginBottom: 0 }}>
            {micError}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {!micTesting ? (
            <button className="vs-btn vs-btn-primary" disabled={permission !== "granted"} onClick={startMicTest}>
              Test Microphone
            </button>
          ) : (
            <button className="vs-btn vs-btn-danger" onClick={stopMicTest}>
              Stop Test
            </button>
          )}
        </div>
      </Card>

      <Card title="Output Test">
        {outputError && (
          <div className="vs-banner vs-banner-error" style={{ marginBottom: 0 }}>
            {outputError}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: outputError ? 12 : 0 }}>
          <button className="vs-btn" disabled={outputTesting} onClick={testOutput}>
            {outputTesting ? "Playing…" : "Test Output"}
          </button>
        </div>
      </Card>

      <Card
        title="Virtual Microphone"
        action={
          meetingModeStatus && (
            <StatusBadge
              tone={meetingModeStatus.ready ? "good" : meetingModeStatus.installed ? "warn" : "idle"}
              label={
                meetingModeStatus.provider === "none"
                  ? "Not available on this platform"
                  : meetingModeStatus.ready
                    ? "Ready"
                    : meetingModeStatus.installed
                      ? "Ambiguous — pick one below"
                      : "Not Installed"
              }
            />
          )
        }
      >
        {meetingModeStatus?.provider !== "none" && (
          <>
            <Row
              label="Provider"
              value={meetingModeStatus?.provider === "vb-cable" ? "VB-CABLE" : meetingModeStatus?.provider === "blackhole" ? "BlackHole" : "—"}
            />
            <Row label="VoiceShift sends audio to" value={meetingModeStatus?.playbackDeviceName ?? "—"} />
            <Row label="Meeting app should use" value={meetingModeStatus?.meetingInputName ?? "—"} />

            {meetingModeStatus?.ambiguous && meetingModeStatus.candidates.length > 0 && (
              <Row
                label="Which device?"
                value={
                  <select
                    className="vs-select"
                    style={{ maxWidth: 260 }}
                    value={settings?.preferredVirtualDeviceId ?? ""}
                    onChange={(e) => update({ preferredVirtualDeviceId: e.target.value || null }).then(() => refreshMeetingModeStatus())}
                  >
                    <option value="">Select…</option>
                    {meetingModeStatus.candidates.map((c) => (
                      <option key={c.deviceId} value={c.deviceId}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                }
              />
            )}

            {virtualTestError && (
              <div className="vs-banner vs-banner-error" style={{ marginTop: 12, marginBottom: 0 }}>
                {virtualTestError}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button
                className="vs-btn"
                disabled={virtualTesting || !meetingModeStatus?.ready}
                onClick={testVirtualMicrophone}
              >
                {virtualTesting ? "Sending…" : "Test Virtual Microphone"}
              </button>
              <button className="vs-btn" onClick={() => setShowGuide((v) => !v)}>
                {showGuide ? "Hide Setup Guide" : "Setup Guide"}
              </button>
              {!meetingModeStatus?.installed && meetingModeStatus?.platform && (
                <button
                  className="vs-btn"
                  onClick={() => {
                    const action = getVirtualAudioIntegration(meetingModeStatus.platform).getSettingsAction();
                    if (action) window.voiceshift.platform.openAudioSettings(action);
                  }}
                >
                  Open Audio Settings
                </button>
              )}
              <button className="vs-btn" onClick={() => refreshMeetingModeStatus()}>
                Re-check
              </button>
            </div>
            {virtualTesting && (
              <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10, marginBottom: 0 }}>
                Check your OS input level meter or your meeting app's microphone test to confirm the signal is
                arriving — VoiceShift cannot reliably verify this from inside the app itself.
              </p>
            )}
          </>
        )}

        {meetingModeStatus?.provider === "none" && (
          <p className="vs-label">Meeting Mode (virtual microphone routing) is only available on Windows and macOS.</p>
        )}

        {showGuide && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
            <MeetingSetupGuide
              platform={meetingModeStatus?.platform ?? "linux"}
              status={meetingModeStatus}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
