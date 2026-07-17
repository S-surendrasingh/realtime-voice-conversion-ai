/** A simple 0..1 level bar — used for mic input level and estimated output
 * level. Never fabricates a value: callers pass 0 when nothing is
 * measured yet. */
export function LevelMeter({ level, label }: { level: number; label?: string }) {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {label && (
        <span className="vs-label" style={{ width: 56 }}>
          {label}
        </span>
      )}
      <div className="vs-meter" role="meter" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={1}>
        <div className="vs-meter-fill" style={{ width: `${clamped * 100}%` }} />
      </div>
    </div>
  );
}
