import type { AgentStatus } from "@car/protocol";
import { STATUS_GLYPH, STATUS_LABEL } from "@car/protocol";

const STATUS_CLASS: Record<AgentStatus, string> = {
  WORKING: "status status-working",
  NEEDS_APPROVAL: "status status-attention",
  NEEDS_INPUT: "status status-attention",
  RESPONDED_UNREAD: "status status-responded",
  IDLE: "status status-idle",
  POSSIBLY_STALE: "status status-stale",
  ERROR: "status status-error",
  CLOSED: "status status-closed",
};

export function StatusBadge({ status, label }: { status: AgentStatus; label?: string }) {
  return (
    <span className={STATUS_CLASS[status]}>
      <span className="status-glyph">{STATUS_GLYPH[status]}</span>
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
