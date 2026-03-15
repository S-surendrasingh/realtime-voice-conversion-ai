import type { VoiceProfileStatus } from "@/types/voice";

const LABEL: Record<VoiceProfileStatus, string> = {
  DRAFT: "Draft",
  RECORDING: "Recording",
  PROCESSING: "Processing",
  READY_FOR_AI_PROCESSING: "Ready for AI Processing",
  FAILED: "Failed",
  ARCHIVED: "Archived",
};

const COLOR: Record<VoiceProfileStatus, string> = {
  DRAFT: "#9ca3af",
  RECORDING: "#3b82f6",
  PROCESSING: "#eab308",
  READY_FOR_AI_PROCESSING: "#22c55e",
  FAILED: "#ef4444",
  ARCHIVED: "#9ca3af",
};

export function VoiceProfileStatusBadge({ status }: { status: VoiceProfileStatus }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontWeight: 600 }}>
      <span style={{ color: COLOR[status] }}>●</span>
      {LABEL[status]}
    </span>
  );
}
