import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import type { EngineLogLine, EngineMode, EngineProcessStatus } from "../shared/types";

const READY_PROBE_INTERVAL_MS = 300;
const READY_PROBE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 4_000;

export interface EngineProcessManagerOptions {
  mode: EngineMode;
  host: string;
  port: number;
  /** Absolute path to the ai-worker venv's python executable (dev) or a
   * bundled standalone engine executable (packaged, see docs/phase4-*
   * packaging notes) — only used when mode === "managed". */
  pythonPath: string;
  /** Working directory to spawn the engine from (ai-worker/ in dev). */
  cwd: string;
  engineName: string;
  onLog?: (line: EngineLogLine) => void;
  onStatusChange?: (status: EngineProcessStatus) => void;
}

/** Owns the lifecycle of exactly ONE resident ai-worker engine process.
 * Reuses the exact existing IPC contract (see src/shared/protocol.ts) only
 * to PROBE readiness/health — the real streaming connection is opened
 * directly by the renderer's EngineClient, not proxied through main. */
export class EngineProcessManager {
  private readonly opts: EngineProcessManagerOptions;
  private child: ChildProcess | null = null;
  private status: EngineProcessStatus;
  private stopping = false;

  constructor(opts: EngineProcessManagerOptions) {
    this.opts = opts;
    this.status = {
      mode: opts.mode,
      running: false,
      ready: false,
      pid: null,
      startedAt: null,
      lastError: null,
      restartCount: 0,
    };
  }

  getStatus(): EngineProcessStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<EngineProcessStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatusChange?.(this.getStatus());
  }

  private emitLog(stream: "stdout" | "stderr", line: string): void {
    this.opts.onLog?.({ stream, line, timestamp: Date.now() });
  }

  async start(): Promise<EngineProcessStatus> {
    if (this.opts.mode === "external") {
      // We don't own this process — only probe that something is already
      // listening and speaking the protocol on host:port.
      const ready = await this.probeReady(READY_PROBE_TIMEOUT_MS);
      this.setStatus({
        running: ready,
        ready,
        lastError: ready ? null : `No resident engine responding at ws://${this.opts.host}:${this.opts.port}`,
      });
      return this.getStatus();
    }

    if (this.child) {
      return this.getStatus();
    }

    if (!existsSync(this.opts.pythonPath)) {
      this.setStatus({
        running: false,
        ready: false,
        lastError: `Engine python not found at ${this.opts.pythonPath}. Run ai-worker's setup (see ai-worker/README.md) or set VOICESHIFT_ENGINE_PYTHON.`,
      });
      return this.getStatus();
    }

    this.stopping = false;
    const args = [
      "-m",
      "app.main",
      "--engine",
      this.opts.engineName,
      "serve",
      "--host",
      this.opts.host,
      "--port",
      String(this.opts.port),
    ];
    const child = spawn(this.opts.pythonPath, args, {
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.setStatus({ running: true, ready: false, pid: child.pid ?? null, startedAt: Date.now(), lastError: null });

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.forwardLines("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => this.forwardLines("stderr", chunk));

    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.setStatus({ running: false, ready: false, pid: null });
        return;
      }
      this.setStatus({
        running: false,
        ready: false,
        pid: null,
        lastError: `Engine process exited unexpectedly (code=${code}, signal=${signal})`,
      });
    });

    child.on("error", (err) => {
      this.setStatus({ running: false, ready: false, pid: null, lastError: `Failed to start engine: ${err.message}` });
    });

    const ready = await this.probeReady(READY_PROBE_TIMEOUT_MS);
    if (ready) {
      this.setStatus({ ready: true });
    } else if (this.child) {
      this.setStatus({ lastError: "Engine process started but did not become ready in time" });
    }
    return this.getStatus();
  }

  private forwardLines(stream: "stdout" | "stderr", chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.length > 0) this.emitLog(stream, line);
    }
  }

  /** Real protocol-level readiness probe: open a short-lived WebSocket,
   * send engine.hello, and require engine.welcome back — a TCP connect
   * alone would not prove the process is actually speaking our protocol. */
  private async probeReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.opts.mode === "managed" && !this.child) return false;
      const ok = await this.probeOnce();
      if (ok) return true;
      await sleep(READY_PROBE_INTERVAL_MS);
    }
    return false;
  }

  private probeOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closing/closed */
        }
        resolve(ok);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${this.opts.host}:${this.opts.port}`);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => finish(false), READY_PROBE_INTERVAL_MS * 2);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ version: 1, type: "engine.hello", request_id: "probe" }));
      });
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(String(event.data));
          finish(msg?.type === "engine.welcome");
        } catch {
          finish(false);
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.probeOnce();
  }

  async restart(): Promise<EngineProcessStatus> {
    this.setStatus({ restartCount: this.status.restartCount + 1 });
    await this.stop();
    return this.start();
  }

  /** Graceful shutdown: ask the engine to shut down over the protocol
   * (engine.shutdown -> engine.shutting_down, see protocol.py) before
   * falling back to SIGTERM/SIGKILL. Never touches an externally-managed
   * process. */
  async stop(): Promise<void> {
    if (this.opts.mode === "external") {
      this.setStatus({ running: false, ready: false });
      return;
    }
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;

    await new Promise<void>((resolve) => {
      let ws: WebSocket | null = null;
      const forceKill = setTimeout(() => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        if (this.child === child) child.kill("SIGTERM");
        resolve();
      }, SHUTDOWN_GRACE_MS);

      try {
        ws = new WebSocket(`ws://${this.opts.host}:${this.opts.port}`);
        ws.addEventListener("open", () => {
          ws?.send(JSON.stringify({ version: 1, type: "engine.shutdown", request_id: "shutdown" }));
        });
        ws.addEventListener("message", () => {
          clearTimeout(forceKill);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(forceKill);
          if (this.child === child) child.kill("SIGTERM");
          resolve();
        });
      } catch {
        clearTimeout(forceKill);
        child.kill("SIGTERM");
        resolve();
      }
    });

    this.setStatus({ running: false, ready: false, pid: null });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveDevEnginePythonPath(repoRoot: string): string {
  return path.join(repoRoot, "ai-worker", ".venv", "bin", "python");
}

export function resolveDevEngineCwd(repoRoot: string): string {
  return path.join(repoRoot, "ai-worker");
}

/** Phase 5 Step 43 — packaged-build path resolution. The standalone
 * per-platform engine executable this resolves to does NOT exist yet (see
 * docs/phase5-virtual-audio.md "Packaging & Distribution" — foundation
 * only, not implemented); this function is real and tested so
 * EngineProcessManager already knows where to look the moment that
 * executable ships, without another code change. Convention:
 * resources/voiceshift-engine/<platform>/voiceshift-engine[.exe]. */
export function resolvePackagedEnginePythonPath(resourcesPath: string, platform: NodeJS.Platform): string {
  const exeName = platform === "win32" ? "voiceshift-engine.exe" : "voiceshift-engine";
  return path.join(resourcesPath, "voiceshift-engine", platform, exeName);
}

export function resolvePackagedEngineCwd(resourcesPath: string, platform: NodeJS.Platform): string {
  return path.join(resourcesPath, "voiceshift-engine", platform);
}
