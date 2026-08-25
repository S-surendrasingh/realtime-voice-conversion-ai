import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsScreen } from "@renderer/screens/SettingsScreen";
import type { PersistedSettings } from "@shared/types";

const BASE_SETTINGS: PersistedSettings = {
  microphoneDeviceId: null,
  outputDeviceId: null,
  voiceProfileId: null,
  engineMode: "managed",
  chunkSizeMs: 500,
  jitterBufferMs: 200,
  backendUrlOverride: null,
  engineWsUrlOverride: null,
  debugMetrics: false,
  debugRecordingEnabled: false,
  outputMode: "local",
  localMonitoringEnabled: false,
  preferredVirtualDeviceId: null,
};

const update = vi.fn();
let mockSettings: PersistedSettings | null = BASE_SETTINGS;

vi.mock("@renderer/hooks/useSettings", () => ({
  useSettings: () => ({ settings: mockSettings, update }),
}));

describe("SettingsScreen", () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue(BASE_SETTINGS);
    mockSettings = BASE_SETTINGS;
  });

  it("renders all controls with the current settings' values reflected", () => {
    render(<SettingsScreen />);

    expect(screen.getByText(/OpenVoice V2 \/ ONNX Runtime \(CPU\)/)).toBeInTheDocument();

    const chunkSelect = screen.getByRole("combobox") as HTMLSelectElement;
    expect(chunkSelect.value).toBe("500");

    const jitterInput = screen.getByDisplayValue("200") as HTMLInputElement;
    expect(jitterInput).toBeInTheDocument();

    const managedRadio = screen.getByRole("radio", { name: /managed/i }) as HTMLInputElement;
    const externalRadio = screen.getByRole("radio", { name: /external/i }) as HTMLInputElement;
    expect(managedRadio.checked).toBe(true);
    expect(externalRadio.checked).toBe(false);

    const debugMetricsCheckbox = screen.getByLabelText(/debug metrics/i) as HTMLInputElement;
    expect(debugMetricsCheckbox.checked).toBe(false);

    const debugRecordingCheckbox = screen.getByLabelText(/debug recording/i) as HTMLInputElement;
    expect(debugRecordingCheckbox.checked).toBe(false);
  });

  it("changing chunk size calls update with a NUMBER, not a string", () => {
    render(<SettingsScreen />);
    const chunkSelect = screen.getByRole("combobox");

    fireEvent.change(chunkSelect, { target: { value: "750" } });

    expect(update).toHaveBeenCalledWith({ chunkSizeMs: 750 });
    const call = update.mock.calls[0][0];
    expect(typeof call.chunkSizeMs).toBe("number");
  });

  it("toggling debug recording off->on calls update with debugRecordingEnabled: true", () => {
    render(<SettingsScreen />);
    const debugRecordingCheckbox = screen.getByLabelText(/debug recording/i);

    fireEvent.click(debugRecordingCheckbox);
    expect(update).toHaveBeenCalledWith({ debugRecordingEnabled: true });
  });

  it("toggling debug recording on->off calls update with debugRecordingEnabled: false", () => {
    mockSettings = { ...BASE_SETTINGS, debugRecordingEnabled: true };
    render(<SettingsScreen />);
    const debugRecordingCheckbox = screen.getByLabelText(/debug recording/i);

    fireEvent.click(debugRecordingCheckbox);
    expect(update).toHaveBeenCalledWith({ debugRecordingEnabled: false });
  });

  it("toggling local monitoring off->on calls update with localMonitoringEnabled: true", () => {
    render(<SettingsScreen />);
    const monitorCheckbox = screen.getByLabelText(/monitor converted voice locally/i);

    fireEvent.click(monitorCheckbox);
    expect(update).toHaveBeenCalledWith({ localMonitoringEnabled: true });
  });

  it("typing a backend URL override and committing it calls update with the string", () => {
    render(<SettingsScreen />);
    const backendUrlInput = screen.getByLabelText("Backend URL");

    fireEvent.change(backendUrlInput, { target: { value: "http://localhost:9000" } });
    fireEvent.blur(backendUrlInput);

    expect(update).toHaveBeenCalledWith({ backendUrlOverride: "http://localhost:9000" });
  });

  it("typing then clearing the backend URL override calls update with null, not empty string", () => {
    render(<SettingsScreen />);
    const backendUrlInput = screen.getByLabelText("Backend URL");

    fireEvent.change(backendUrlInput, { target: { value: "http://localhost:9000" } });
    fireEvent.blur(backendUrlInput);
    update.mockClear();

    fireEvent.change(backendUrlInput, { target: { value: "" } });
    fireEvent.blur(backendUrlInput);

    expect(update).toHaveBeenCalledWith({ backendUrlOverride: null });
  });

  it("rejects a malformed backend URL override with a clear inline error, and does not call update", () => {
    render(<SettingsScreen />);
    const backendUrlInput = screen.getByLabelText("Backend URL");

    fireEvent.change(backendUrlInput, { target: { value: "not-a-url" } });
    fireEvent.blur(backendUrlInput);

    expect(screen.getByText("Not a valid URL.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a backend URL override with the wrong protocol (ws:// instead of http://)", () => {
    render(<SettingsScreen />);
    const backendUrlInput = screen.getByLabelText("Backend URL");

    fireEvent.change(backendUrlInput, { target: { value: "ws://127.0.0.1:8000" } });
    fireEvent.blur(backendUrlInput);

    expect(screen.getByText(/Must start with http or https/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an engine WebSocket URL override with the wrong protocol (http:// instead of ws://)", () => {
    render(<SettingsScreen />);
    const engineWsUrlInput = screen.getByLabelText("Engine WebSocket URL");

    fireEvent.change(engineWsUrlInput, { target: { value: "http://127.0.0.1:8765" } });
    fireEvent.blur(engineWsUrlInput);

    expect(screen.getByText(/Must start with ws or wss/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts a valid wss:// engine WebSocket URL override", () => {
    render(<SettingsScreen />);
    const engineWsUrlInput = screen.getByLabelText("Engine WebSocket URL");

    fireEvent.change(engineWsUrlInput, { target: { value: "wss://127.0.0.1:8765" } });
    fireEvent.blur(engineWsUrlInput);

    expect(update).toHaveBeenCalledWith({ engineWsUrlOverride: "wss://127.0.0.1:8765" });
  });

  it("renders without crashing when settings are still loading (null)", () => {
    mockSettings = null;
    expect(() => render(<SettingsScreen />)).not.toThrow();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
