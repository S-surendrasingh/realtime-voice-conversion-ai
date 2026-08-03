import { useState } from "react";
import { Card, Row } from "../components/Card";
import { useSettings } from "../hooks/useSettings";
import type { ChunkSizeMs, EngineMode } from "@shared/types";

const CHUNK_SIZE_OPTIONS: ChunkSizeMs[] = [250, 500, 750, 1000];

/** Returns an error message if `value` isn't a well-formed URL with one of
 * `expectedProtocols`, or null if it's valid (an empty string is always
 * valid — it means "clear the override, use the automatic default"). */
function validateUrlOverride(value: string, expectedProtocols: string[]): string | null {
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Not a valid URL.";
  }
  if (!expectedProtocols.includes(url.protocol)) {
    return `Must start with ${expectedProtocols.map((p) => p.replace(":", "")).join(" or ")}://`;
  }
  return null;
}

/** Settings screen: a SMALL set of user-facing preferences, not a dumping
 * ground for model internals. Everything here is backed by the persisted
 * PersistedSettings store via useSettings() — see
 * src/renderer/src/hooks/useSettings.ts and src/shared/types.ts. */
export function SettingsScreen() {
  const { settings, update } = useSettings();
  const [backendUrlError, setBackendUrlError] = useState<string | null>(null);
  const [engineWsUrlError, setEngineWsUrlError] = useState<string | null>(null);

  if (!settings) {
    return (
      <div>
        <h1 className="vs-page-title">Settings</h1>
        <p className="vs-page-subtitle">Loading settings…</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="vs-page-title">Settings</h1>
      <p className="vs-page-subtitle">A small set of preferences that control streaming and engine behavior.</p>

      <Card title="Engine & Streaming">
        <Row label="AI Engine" value="OpenVoice V2 / ONNX Runtime (CPU)" />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
          Fixed for now — there is no in-app switch to another engine.
        </div>

        <Row
          label="Chunk Size"
          value={
            <select
              className="vs-select"
              style={{ maxWidth: 160 }}
              value={settings.chunkSizeMs}
              onChange={(e) => update({ chunkSizeMs: Number(e.target.value) as ChunkSizeMs })}
            >
              {CHUNK_SIZE_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms
                </option>
              ))}
            </select>
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
          Size of each live-streaming audio chunk sent to the AI engine. 500ms is the Phase 3.2 benchmark-selected
          balanced value — smaller chunks feel more responsive but cost more overhead; larger chunks are more
          efficient but add latency.
        </div>

        <Row
          label="Audio Buffer"
          value={
            <input
              type="number"
              className="vs-input"
              style={{ maxWidth: 100 }}
              min={50}
              max={1000}
              step={10}
              defaultValue={settings.jitterBufferMs}
              onBlur={(e) => update({ jitterBufferMs: Number(e.target.value) })}
            />
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
          Playback jitter buffer size, in milliseconds (50–1000).
        </div>

        <Row
          label="Engine Mode (restart required to take effect)"
          value={
            <div style={{ display: "flex", gap: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="engine-mode"
                  value="managed"
                  checked={settings.engineMode === "managed"}
                  onChange={() => update({ engineMode: "managed" as EngineMode })}
                />
                Managed
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="engine-mode"
                  value="external"
                  checked={settings.engineMode === "external"}
                  onChange={() => update({ engineMode: "external" as EngineMode })}
                />
                External
              </label>
            </div>
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
          "Managed" — the app starts and stops the AI engine process itself. "External" — you start the engine
          process yourself (for development). This only takes effect the next time the app starts; it does not
          hot-swap the currently running engine.
        </div>

        <Row
          label="Debug Metrics"
          value={
            <input
              type="checkbox"
              aria-label="Debug Metrics"
              checked={settings.debugMetrics}
              onChange={(e) => update({ debugMetrics: e.target.checked })}
            />
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
          Show additional debug metrics in Live Voice.
        </div>

        <Row
          label="Monitor Converted Voice Locally"
          value={
            <input
              type="checkbox"
              aria-label="Monitor Converted Voice Locally"
              checked={settings.localMonitoringEnabled}
              onChange={(e) => update({ localMonitoringEnabled: e.target.checked })}
            />
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4 }}>
          When Output Mode is Meeting Mode, also play the converted voice through your normal speakers/headphones
          (from the same converted audio — never a second AI pass). Off by default to avoid feedback; only enable if
          you're using headphones.
        </div>
      </Card>

      <Card title="Advanced / Developer Settings">
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 10 }}>
          Backend and AI engine addresses are automatic (<code>http://127.0.0.1:8000</code> and{" "}
          <code>ws://127.0.0.1:8765</code>) — you never need to enter them. These overrides exist only for
          development, e.g. running services on non-default ports.
        </p>
        <Row
          label="Backend URL"
          value={
            <input
              type="text"
              className="vs-input"
              aria-label="Backend URL"
              placeholder="Automatic (http://127.0.0.1:8000)"
              defaultValue={settings.backendUrlOverride ?? ""}
              onBlur={(e) => {
                const value = e.target.value.trim();
                const error = validateUrlOverride(value, ["http:", "https:"]);
                setBackendUrlError(error);
                if (!error) update({ backendUrlOverride: value || null });
              }}
            />
          }
        />
        {backendUrlError ? (
          <div className="vs-banner vs-banner-error" style={{ marginTop: -4, marginBottom: 4, padding: "6px 10px" }}>
            {backendUrlError}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
            Leave blank to use the automatic default.
          </div>
        )}

        <Row
          label="Engine WebSocket URL"
          value={
            <input
              type="text"
              className="vs-input"
              aria-label="Engine WebSocket URL"
              placeholder="Automatic (ws://127.0.0.1:8765)"
              defaultValue={settings.engineWsUrlOverride ?? ""}
              onBlur={(e) => {
                const value = e.target.value.trim();
                const error = validateUrlOverride(value, ["ws:", "wss:"]);
                setEngineWsUrlError(error);
                if (!error) update({ engineWsUrlOverride: value || null });
              }}
            />
          }
        />
        {engineWsUrlError ? (
          <div className="vs-banner vs-banner-error" style={{ marginTop: -4, marginBottom: 4, padding: "6px 10px" }}>
            {engineWsUrlError}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 4 }}>
            Leave blank to use the automatic default. Unlike Engine Mode, this takes effect the next time you press
            "Start Live" — no restart needed.
          </div>
        )}

        <Row
          label="Debug Recording"
          value={
            <input
              type="checkbox"
              aria-label="Debug Recording"
              checked={settings.debugRecordingEnabled}
              onChange={(e) => update({ debugRecordingEnabled: e.target.checked })}
            />
          }
        />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4 }}>
          Record raw microphone/converted audio for debugging (off by default — live voice audio is never saved
          otherwise).
        </div>
      </Card>
    </div>
  );
}
