/** Single source of truth for VoiceShift's local service defaults —
 * imported by main (which resolves env var overrides) and by anything
 * that needs to know the defaults without duplicating the literal URLs.
 * A normal user never sets any of these; they exist so `scripts/start_dev.py`,
 * `main/config.ts`, and this file all agree on exactly one set of numbers. */

/** Matches ai-worker/app/core/config.py Settings.server_host — never
 * 0.0.0.0, loopback only (see docs/phase4-desktop.md "IPC"). */
export const DEFAULT_ENGINE_HOST = "127.0.0.1";
/** Matches ai-worker/app/core/config.py Settings.server_port. */
export const DEFAULT_ENGINE_PORT = 8765;
/** Matches backend/app/main.py's local dev bind (see scripts/start_dev.py,
 * which binds it to 127.0.0.1 explicitly rather than the Makefile's 0.0.0.0). */
export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

export function buildEngineWsUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}

export const DEFAULT_ENGINE_WS_URL = buildEngineWsUrl(DEFAULT_ENGINE_HOST, DEFAULT_ENGINE_PORT);
