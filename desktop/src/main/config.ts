import path from "node:path";
import { app } from "electron";
import {
  resolveDevEngineCwd,
  resolveDevEnginePythonPath,
  resolvePackagedEngineCwd,
  resolvePackagedEnginePythonPath,
} from "./engineProcessManager";
import { buildEngineWsUrl, DEFAULT_BACKEND_URL, DEFAULT_ENGINE_HOST, DEFAULT_ENGINE_PORT } from "../shared/serviceConfig";
import type { EngineMode } from "../shared/types";

/** Repo root, two levels up from desktop/ (desktop/src/main -> desktop ->
 * repo root). Only meaningful in dev — a packaged build has no ai-worker/
 * sibling and must use a bundled engine resource instead (see
 * docs/phase5-virtual-audio.md). */
function resolveRepoRoot(): string {
  return path.resolve(app.getAppPath(), "..");
}

export interface MainConfig {
  engineMode: EngineMode;
  engineHost: string;
  engineWsPort: number;
  /** The exact ws:// URL the renderer connects to — computed once, here,
   * so nothing else in the app reconstructs `ws://${host}:${port}` itself
   * (the literal-URL duplication scripts/start_dev.py and this config
   * previously both did independently). */
  engineWsUrl: string;
  enginePythonPath: string;
  engineCwd: string;
  engineName: string;
  engineSampleRate: number;
  backendUrl: string;
}

/** Every field here is environment-driven, matching the convention already
 * used by backend/app/core/config.py and ai-worker/app/core/config.py.
 * Defaults come from shared/serviceConfig.ts — never guessed independently,
 * and never duplicated as literal strings elsewhere (scripts/start_dev.py
 * uses the same numbers, documented in docs/development.md). A normal user
 * never needs to set VOICESHIFT_BACKEND_URL or VOICESHIFT_ENGINE_WS_URL;
 * they exist for developers running services on non-default ports. */
export function loadMainConfig(): MainConfig {
  const mode = (process.env.VOICESHIFT_ENGINE_MODE as EngineMode | undefined) ?? "managed";
  // Packaged-build path resolution (Step 43) — the packaged engine
  // executable itself doesn't exist yet (foundation only, see
  // docs/phase5-virtual-audio.md), but the resolution logic is real: once
  // it ships at resources/voiceshift-engine/<platform>/, this picks it up
  // automatically with no further code change. Dev (unpackaged) keeps
  // resolving ai-worker/.venv/ relative to the repo root, as before.
  const enginePythonPath = app.isPackaged
    ? resolvePackagedEnginePythonPath(process.resourcesPath, process.platform)
    : resolveDevEnginePythonPath(resolveRepoRoot());
  const engineCwd = app.isPackaged
    ? resolvePackagedEngineCwd(process.resourcesPath, process.platform)
    : resolveDevEngineCwd(resolveRepoRoot());

  const engineHost = process.env.VOICESHIFT_ENGINE_HOST ?? DEFAULT_ENGINE_HOST;
  const engineWsPort = Number(process.env.VOICESHIFT_ENGINE_PORT ?? DEFAULT_ENGINE_PORT);
  // VOICESHIFT_ENGINE_WS_URL overrides the whole constructed URL directly
  // (e.g. pointing at a non-loopback host) — takes precedence over
  // host/port when set, since it's the more specific override.
  const engineWsUrl = process.env.VOICESHIFT_ENGINE_WS_URL ?? buildEngineWsUrl(engineHost, engineWsPort);

  return {
    engineMode: mode === "external" ? "external" : "managed",
    engineHost,
    engineWsPort,
    engineWsUrl,
    enginePythonPath: process.env.VOICESHIFT_ENGINE_PYTHON ?? enginePythonPath,
    engineCwd: process.env.VOICESHIFT_ENGINE_CWD ?? engineCwd,
    // Phase 3.2's chosen default live engine — see ai-worker/README.md
    // ("Default engine: openvoice_onnx") and docs/phase3.2-openvoice-onnx.md.
    // Settings.engine in ai-worker still defaults to seed_vc for backward
    // compatibility with existing CLI users, so this must be passed
    // explicitly, never left to that default.
    engineName: process.env.VOICESHIFT_ENGINE_NAME ?? "openvoice_onnx",
    // Matches ai-worker/app/core/config.py Settings.openvoice_sample_rate's
    // default exactly — see docs/phase3.2-openvoice-onnx.md. Override only
    // if ai-worker's own AI_OPENVOICE_SAMPLE_RATE is also overridden.
    engineSampleRate: Number(process.env.VOICESHIFT_ENGINE_SAMPLE_RATE ?? 22050),
    backendUrl: process.env.VOICESHIFT_BACKEND_URL ?? DEFAULT_BACKEND_URL,
  };
}
