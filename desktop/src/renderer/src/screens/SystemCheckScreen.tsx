import { useCallback, useEffect, useState } from "react";
import { Card, Row } from "../components/Card";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import { useEngineStatus } from "../hooks/useEngineStatus";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { getBackendClient, useLiveVoiceStore } from "../services/singletons";
import type { PlatformInfo } from "@shared/ipcApi";

type CheckState = "checking" | "ok" | "fail";

/** System Check screen (Step ~ per product spec): shows REAL, live state for
 * AI Engine, Model, Device, Backend, Microphone, Output. Never fabricates a
 * green "Ready" — anything that can't be confirmed working is shown as
 * "warn" (checking/unknown) or "bad" (confirmed unavailable), reusing the
 * exact same hooks/services the rest of the app uses (useEngineStatus,
 * useMediaDevices, BackendClient.checkAvailable, platform.getInfo) rather
 * than any new IPC call. */
export function SystemCheckScreen() {
  const { status, start, healthCheck } = useEngineStatus();
  const { inputDevices, outputDevices, permission, refresh } = useMediaDevices();
  const { meetingModeStatus, refreshMeetingModeStatus } = useLiveVoiceStore();

  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [engineHealth, setEngineHealth] = useState<CheckState>("checking");
  const [backendState, setBackendState] = useState<CheckState>("checking");
  const [isChecking, setIsChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const runEngineHealthCheck = useCallback(async () => {
    setEngineHealth("checking");
    try {
      const ok = await healthCheck();
      setEngineHealth(ok ? "ok" : "fail");
    } catch {
      setEngineHealth("fail");
    }
  }, [healthCheck]);

  const runBackendCheck = useCallback(async () => {
    setBackendState("checking");
    try {
      const client = await getBackendClient();
      const ok = await client.checkAvailable();
      setBackendState(ok ? "ok" : "fail");
    } catch {
      setBackendState("fail");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.voiceshift.platform.getInfo().then((info) => {
      if (!cancelled) setPlatformInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    runEngineHealthCheck();
    runBackendCheck();
    refreshMeetingModeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runFullCheck = useCallback(async () => {
    setIsChecking(true);
    try {
      await Promise.all([refresh(), runEngineHealthCheck(), runBackendCheck(), refreshMeetingModeStatus()]);
    } finally {
      setIsChecking(false);
    }
  }, [refresh, runEngineHealthCheck, runBackendCheck, refreshMeetingModeStatus]);

  const handleStartEngine = useCallback(async () => {
    setStarting(true);
    try {
      await start();
      await runEngineHealthCheck();
    } finally {
      setStarting(false);
    }
  }, [start, runEngineHealthCheck]);

  // "ready" here means both the cached process status (status.ready, set by
  // main's EngineProcessManager) AND a live protocol-level probe
  // (healthCheck(), a real round trip) agree — a cached "ready" flag that
  // the live probe can't confirm is shown as failing, never as good, per
  // the "never fake a green ready state" requirement.
  const engineCachedReady = !!status?.ready;
  let engineTone: StatusTone;
  let engineLabel: string;
  if (!status) {
    engineTone = "warn";
    engineLabel = "Checking…";
  } else if (!engineCachedReady) {
    engineTone = "bad";
    engineLabel = "Not Ready";
  } else if (engineHealth === "checking") {
    engineTone = "warn";
    engineLabel = "Verifying…";
  } else if (engineHealth === "ok") {
    engineTone = "good";
    engineLabel = "Ready";
  } else {
    engineTone = "bad";
    engineLabel = "Reported Ready, But Unreachable";
  }
  const engineReady = engineTone === "good";

  const modelTone: StatusTone = engineReady ? "good" : "idle";

  const platformTone: StatusTone = platformInfo ? "good" : "warn";
  const platformLabel = platformInfo ? `CPU (${platformInfo.name})` : "Checking…";

  const backendTone: StatusTone = backendState === "checking" ? "warn" : backendState === "ok" ? "good" : "bad";
  const backendLabel = backendState === "checking" ? "Checking…" : backendState === "ok" ? "Available" : "Unavailable";

  const micTone: StatusTone =
    permission === "granted" && inputDevices.length > 0
      ? "good"
      : permission === "denied" || permission === "no-device"
        ? "bad"
        : "warn";
  const micLabel =
    permission === "granted" && inputDevices.length > 0
      ? `Available (${inputDevices.length})`
      : permission === "denied"
        ? "Permission Denied"
        : permission === "no-device"
          ? "No Microphone Found"
          : "Checking…";

  const outputTone: StatusTone = outputDevices.length > 0 ? "good" : "bad";
  const outputLabel = outputDevices.length > 0 ? `Available (${outputDevices.length})` : "Not Found";

  // Virtual audio driver / Meeting Mode rows (Step 18) — always sourced
  // from real, freshly-enumerated device state via meetingModeStatus.
  // Never true just because the AI engine is ready.
  const providerName =
    meetingModeStatus?.provider === "vb-cable" ? "VB-CABLE" : meetingModeStatus?.provider === "blackhole" ? "BlackHole" : null;
  const driverTone: StatusTone = !meetingModeStatus
    ? "warn"
    : meetingModeStatus.provider === "none"
      ? "idle"
      : meetingModeStatus.installed
        ? "good"
        : "bad";
  const driverLabel = !meetingModeStatus
    ? "Checking…"
    : meetingModeStatus.provider === "none"
      ? "Not applicable (Linux dev)"
      : meetingModeStatus.installed
        ? "Installed"
        : "Not Installed";

  let meetingModeTone: StatusTone;
  let meetingModeLabel: string;
  if (!meetingModeStatus) {
    meetingModeTone = "warn";
    meetingModeLabel = "Checking…";
  } else if (meetingModeStatus.provider === "none") {
    meetingModeTone = "idle";
    meetingModeLabel = "Not applicable (Linux dev)";
  } else if (meetingModeStatus.ready) {
    meetingModeTone = "good";
    meetingModeLabel = "Ready";
  } else {
    meetingModeTone = "bad";
    meetingModeLabel = "Not Ready";
  }

  return (
    <div>
      <h1 className="vs-page-title">System Check</h1>
      <p className="vs-page-subtitle">
        Live status of the pieces Live Voice depends on. Nothing here is guessed — a check that can't be confirmed
        shows as unknown or failing, never a fake "Ready".
      </p>

      <Card
        title="Status"
        action={
          <button className="vs-btn vs-btn-primary" disabled={isChecking} onClick={runFullCheck}>
            {isChecking ? "Checking…" : "Run System Check"}
          </button>
        }
      >
        <Row
          label="AI Engine"
          value={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StatusBadge tone={engineTone} label={engineLabel} />
              {!engineReady && (
                <button className="vs-btn" disabled={starting} onClick={handleStartEngine}>
                  {starting ? "Starting…" : "Start Engine"}
                </button>
              )}
            </div>
          }
        />
        {status?.lastError && (
          <Row label="Last Engine Error" value={<span style={{ color: "var(--status-bad)" }}>{status.lastError}</span>} />
        )}
        <Row
          label="Model"
          value={<StatusBadge tone={modelTone} label="OpenVoice V2 / ONNX Runtime (CPU)" />}
        />
        <Row label="Device / Platform" value={<StatusBadge tone={platformTone} label={platformLabel} />} />
        <Row label="Backend" value={<StatusBadge tone={backendTone} label={backendLabel} />} />
        <Row label="Microphone" value={<StatusBadge tone={micTone} label={micLabel} />} />
        <Row label="Audio Output" value={<StatusBadge tone={outputTone} label={outputLabel} />} />
        <Row
          label={providerName ? `${providerName} (Virtual Audio Driver)` : "Virtual Audio Driver"}
          value={<StatusBadge tone={driverTone} label={driverLabel} />}
        />
        {meetingModeStatus?.playbackDeviceName && (
          <Row label="VoiceShift Output" value={meetingModeStatus.playbackDeviceName} />
        )}
        {meetingModeStatus?.meetingInputName && (
          <Row label="Meeting Microphone" value={meetingModeStatus.meetingInputName} />
        )}
        <Row label="Meeting Mode" value={<StatusBadge tone={meetingModeTone} label={meetingModeLabel} />} />
      </Card>
    </div>
  );
}
