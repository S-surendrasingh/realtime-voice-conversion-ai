"use client";

import { useBackendHealth } from "@/hooks/useBackendHealth";

const LABEL: Record<string, string> = {
  checking: "Checking...",
  connected: "Connected",
  disconnected: "Disconnected",
};

const COLOR: Record<string, string> = {
  checking: "#eab308",
  connected: "#22c55e",
  disconnected: "#ef4444",
};

export function BackendStatusBadge() {
  const status = useBackendHealth();

  return (
    <p style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span>Backend Status:</span>
      <span style={{ color: COLOR[status], fontWeight: 600 }}>
        ● {LABEL[status]}
      </span>
    </p>
  );
}
