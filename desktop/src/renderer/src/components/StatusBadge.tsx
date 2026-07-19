export type StatusTone = "good" | "warn" | "bad" | "idle";

const TONE_COLOR: Record<StatusTone, string> = {
  good: "var(--status-good)",
  warn: "var(--status-warn)",
  bad: "var(--status-bad)",
  idle: "var(--status-idle)",
};

export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="vs-status-badge" style={{ color: TONE_COLOR[tone] }}>
      <span className="vs-status-dot" style={{ background: TONE_COLOR[tone] }} />
      {label}
    </span>
  );
}
