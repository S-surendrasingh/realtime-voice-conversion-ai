// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
}));

const existsSyncMock = vi.fn((_p: string) => true);
vi.mock("node:fs", () => ({ existsSync: (p: string) => existsSyncMock(p) }));

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static behavior: "welcome" | "timeout" | "refuse" = "welcome";
  url: string;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.behavior === "refuse") {
        this.emit("error", new Error("ECONNREFUSED"));
        return;
      }
      this.emit("open");
    });
  }
  addEventListener(event: string, cb: (...args: unknown[]) => void): void {
    this.on(event, cb);
  }
  send(data: string): void {
    this.sent.push(data);
    if (FakeWebSocket.behavior === "welcome") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ version: 1, type: "engine.welcome" }) }));
    }
    // "timeout" behavior: never respond.
  }
  close(): void {
    this.closed = true;
  }
}
vi.mock("ws", () => ({ WebSocket: FakeWebSocket }));

const { EngineProcessManager, resolvePackagedEnginePythonPath, resolvePackagedEngineCwd } = await import(
  "../../src/main/engineProcessManager"
);

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  (child.stdout as EventEmitter & { setEncoding?: () => void }).setEncoding = () => undefined;
  (child.stderr as EventEmitter & { setEncoding?: () => void }).setEncoding = () => undefined;
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

describe("EngineProcessManager (managed mode)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
    FakeWebSocket.instances = [];
    FakeWebSocket.behavior = "welcome";
  });
  afterEach(() => vi.useRealTimers());

  function baseOpts() {
    return {
      mode: "managed" as const,
      host: "127.0.0.1",
      port: 8765,
      pythonPath: "/fake/.venv/bin/python",
      cwd: "/fake/ai-worker",
      engineName: "openvoice_onnx",
    };
  }

  it("spawns python -m app.main --engine <name> serve --host --port", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const manager = new EngineProcessManager(baseOpts());
    const statusPromise = manager.start();
    const status = await statusPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/.venv/bin/python",
      ["-m", "app.main", "--engine", "openvoice_onnx", "serve", "--host", "127.0.0.1", "--port", "8765"],
      expect.objectContaining({ cwd: "/fake/ai-worker" })
    );
    expect(status.running).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.pid).toBe(4242);
  });

  it("reports not-ready and a clear error if the python path does not exist", async () => {
    existsSyncMock.mockReturnValue(false);
    const manager = new EngineProcessManager(baseOpts());
    const status = await manager.start();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(status.running).toBe(false);
    expect(status.lastError).toMatch(/not found/);
  });

  it("captures stdout/stderr lines via onLog", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const logs: Array<{ stream: string; line: string }> = [];
    const manager = new EngineProcessManager({ ...baseOpts(), onLog: (l) => logs.push(l) });
    await manager.start();
    child.stdout.emit("data", "line one\nline two\n");
    child.stderr.emit("data", "an error\n");
    expect(logs).toEqual([
      { stream: "stdout", line: "line one", timestamp: expect.any(Number) },
      { stream: "stdout", line: "line two", timestamp: expect.any(Number) },
      { stream: "stderr", line: "an error", timestamp: expect.any(Number) },
    ]);
  });

  it("marks status not-running with lastError on unexpected exit", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const statuses: Array<{ running: boolean; lastError: string | null }> = [];
    const manager = new EngineProcessManager({ ...baseOpts(), onStatusChange: (s) => statuses.push(s) });
    await manager.start();
    child.emit("exit", 1, null);
    const last = statuses[statuses.length - 1];
    expect(last.running).toBe(false);
    expect(last.lastError).toMatch(/unexpectedly/);
  });

  it("does not report an error on exit after an explicit stop()", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const manager = new EngineProcessManager(baseOpts());
    await manager.start();
    const stopPromise = manager.stop();
    child.emit("exit", 0, null);
    await stopPromise;
    expect(manager.getStatus().lastError).toBeNull();
  });

  it("restart() calls stop() then start() again, tracking restartCount", async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const manager = new EngineProcessManager(baseOpts());
    await manager.start();
    const restartPromise = manager.restart();
    child1.emit("exit", 0, null);
    await restartPromise;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().restartCount).toBe(1);
    expect(manager.getStatus().running).toBe(true);
  });

  it("healthCheck() reflects real protocol-level reachability, not just TCP", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const manager = new EngineProcessManager(baseOpts());
    await manager.start();
    await expect(manager.healthCheck()).resolves.toBe(true);
    FakeWebSocket.behavior = "timeout";
    await expect(manager.healthCheck()).resolves.toBe(false);
  });
});

describe("EngineProcessManager (external mode)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    FakeWebSocket.instances = [];
    FakeWebSocket.behavior = "welcome";
  });

  it("never spawns a process and only probes the given host:port", async () => {
    const manager = new EngineProcessManager({
      mode: "external",
      host: "127.0.0.1",
      port: 8765,
      pythonPath: "unused",
      cwd: "unused",
      engineName: "openvoice_onnx",
    });
    const status = await manager.start();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(status.running).toBe(true);
    expect(status.ready).toBe(true);
  });

  it("reports not running when nothing answers", async () => {
    FakeWebSocket.behavior = "timeout";
    const manager = new EngineProcessManager({
      mode: "external",
      host: "127.0.0.1",
      port: 8765,
      pythonPath: "unused",
      cwd: "unused",
      engineName: "openvoice_onnx",
    });
    // Probing loops for up to 30s in real code; keep this test fast by
    // constructing with a manager and asserting on a single probe cycle
    // via healthCheck() instead of the full start() retry loop.
    await expect(manager.healthCheck()).resolves.toBe(false);
  });

  it("stop() never sends engine.shutdown to an externally-managed process", async () => {
    const manager = new EngineProcessManager({
      mode: "external",
      host: "127.0.0.1",
      port: 8765,
      pythonPath: "unused",
      cwd: "unused",
      engineName: "openvoice_onnx",
    });
    await manager.start();
    await manager.stop();
    expect(FakeWebSocket.instances.every((ws) => !ws.sent.some((s) => s.includes("engine.shutdown")))).toBe(true);
  });
});

describe("packaged-build path resolution (Phase 5 Step 43)", () => {
  it("resolves a Windows executable path under resources/voiceshift-engine/win32/", () => {
    expect(resolvePackagedEnginePythonPath("/opt/VoiceShift/resources", "win32")).toBe(
      "/opt/VoiceShift/resources/voiceshift-engine/win32/voiceshift-engine.exe"
    );
  });

  it("resolves a macOS/Linux executable path without a .exe suffix", () => {
    expect(resolvePackagedEnginePythonPath("/opt/VoiceShift/resources", "darwin")).toBe(
      "/opt/VoiceShift/resources/voiceshift-engine/darwin/voiceshift-engine"
    );
  });

  it("resolves the packaged engine cwd per-platform", () => {
    expect(resolvePackagedEngineCwd("/opt/VoiceShift/resources", "win32")).toBe(
      "/opt/VoiceShift/resources/voiceshift-engine/win32"
    );
    expect(resolvePackagedEngineCwd("/opt/VoiceShift/resources", "darwin")).toBe(
      "/opt/VoiceShift/resources/voiceshift-engine/darwin"
    );
  });
});
