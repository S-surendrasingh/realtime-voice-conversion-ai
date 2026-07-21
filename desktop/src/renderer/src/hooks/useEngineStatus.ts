import { useCallback, useEffect, useState } from "react";
import type { EngineLogLine, EngineProcessStatus } from "@shared/types";

const MAX_LOG_LINES = 200;

/** Live-updating view of the resident engine process, backed by
 * EngineProcessManager in main via the preload bridge — used by System
 * Check and Settings. Never fabricates a "ready" state: reflects only
 * what main has actually observed (see engineProcessManager.ts). */
export function useEngineStatus() {
  const [status, setStatus] = useState<EngineProcessStatus | null>(null);
  const [logs, setLogs] = useState<EngineLogLine[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.voiceshift.engine.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const unsubStatus = window.voiceshift.engine.onStatusChange((s) => setStatus(s));
    const unsubLog = window.voiceshift.engine.onLog((line) =>
      setLogs((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), line])
    );
    return () => {
      cancelled = true;
      unsubStatus();
      unsubLog();
    };
  }, []);

  const start = useCallback(async () => {
    const s = await window.voiceshift.engine.start();
    setStatus(s);
    return s;
  }, []);

  const restart = useCallback(async () => {
    const s = await window.voiceshift.engine.restart();
    setStatus(s);
    return s;
  }, []);

  const healthCheck = useCallback(() => window.voiceshift.engine.healthCheck(), []);

  return { status, logs, start, restart, healthCheck };
}
