"use client";

import { useEffect, useState } from "react";
import { fetchBackendHealth } from "@/lib/api";
import type { BackendConnectionStatus } from "@/types/health";

const POLL_INTERVAL_MS = 5000;

export function useBackendHealth(): BackendConnectionStatus {
  const [status, setStatus] = useState<BackendConnectionStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function check() {
      try {
        await fetchBackendHealth(controller.signal);
        if (!cancelled) setStatus("connected");
      } catch {
        if (!cancelled) setStatus("disconnected");
      }
    }

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  return status;
}
