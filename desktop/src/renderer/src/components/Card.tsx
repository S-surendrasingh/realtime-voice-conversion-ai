import type { PropsWithChildren, ReactNode } from "react";

export function Card({ title, action, children }: PropsWithChildren<{ title?: string; action?: ReactNode }>) {
  return (
    <div className="vs-card">
      {(title || action) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          {title && <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="vs-row">
      <span className="vs-label">{label}</span>
      <span className="vs-value">{value}</span>
    </div>
  );
}
