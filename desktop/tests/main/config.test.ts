// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = {
  isPackaged: false,
  getAppPath: vi.fn(() => "/repo/desktop"),
};
vi.mock("electron", () => ({ app: appMock }));

const { loadMainConfig } = await import("../../src/main/config");

const ENV_KEYS = [
  "VOICESHIFT_ENGINE_MODE",
  "VOICESHIFT_ENGINE_HOST",
  "VOICESHIFT_ENGINE_PORT",
  "VOICESHIFT_ENGINE_WS_URL",
  "VOICESHIFT_ENGINE_PYTHON",
  "VOICESHIFT_ENGINE_CWD",
  "VOICESHIFT_ENGINE_NAME",
  "VOICESHIFT_ENGINE_SAMPLE_RATE",
  "VOICESHIFT_BACKEND_URL",
] as const;

describe("loadMainConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    appMock.isPackaged = false;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("defaults to the documented local service URLs with no env vars set — normal users never configure these", () => {
    const config = loadMainConfig();
    expect(config.backendUrl).toBe("http://127.0.0.1:8000");
    expect(config.engineHost).toBe("127.0.0.1");
    expect(config.engineWsPort).toBe(8765);
    expect(config.engineWsUrl).toBe("ws://127.0.0.1:8765");
  });

  it("VOICESHIFT_BACKEND_URL overrides the default backend URL", () => {
    process.env.VOICESHIFT_BACKEND_URL = "http://127.0.0.1:9000";
    expect(loadMainConfig().backendUrl).toBe("http://127.0.0.1:9000");
  });

  it("VOICESHIFT_ENGINE_HOST/PORT override the constructed engineWsUrl", () => {
    process.env.VOICESHIFT_ENGINE_HOST = "127.0.0.1";
    process.env.VOICESHIFT_ENGINE_PORT = "9999";
    const config = loadMainConfig();
    expect(config.engineWsPort).toBe(9999);
    expect(config.engineWsUrl).toBe("ws://127.0.0.1:9999");
  });

  it("VOICESHIFT_ENGINE_WS_URL takes precedence over host/port when both are set", () => {
    process.env.VOICESHIFT_ENGINE_HOST = "127.0.0.1";
    process.env.VOICESHIFT_ENGINE_PORT = "9999";
    process.env.VOICESHIFT_ENGINE_WS_URL = "ws://127.0.0.1:7000";
    expect(loadMainConfig().engineWsUrl).toBe("ws://127.0.0.1:7000");
  });

  it("defaults engineMode to managed, and honors external", () => {
    expect(loadMainConfig().engineMode).toBe("managed");
    process.env.VOICESHIFT_ENGINE_MODE = "external";
    expect(loadMainConfig().engineMode).toBe("external");
  });

  it("always passes openvoice_onnx explicitly — never relies on ai-worker's own default", () => {
    expect(loadMainConfig().engineName).toBe("openvoice_onnx");
  });
});
