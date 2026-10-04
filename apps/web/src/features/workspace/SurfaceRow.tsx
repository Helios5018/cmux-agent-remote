import { useState } from "react";
import { AGENT_DISPLAY_NAME, STATUS_GLYPH, STATUS_LABEL, type AgentState, type CmuxSurface } from "@car/protocol";
import { formatAgo, formatDuration } from "@car/shared";
import { useAppStore } from "../../stores/AppStore.tsx";

const STATUS_TONE: Record<string, string> = {
  WORKING: "status-working",
  NEEDS_APPROVAL: "status-attention",
  NEEDS_INPUT: "status-attention",
  RESPONDED_UNREAD: "status-responded",
  IDLE: "status-idle",
  POSSIBLY_STALE: "status-stale",
  ERROR: "status-error",
  CLOSED: "status-closed",
};

export function SurfaceRow({
  surface,
  agent,
  now,
  lastInWorkspace,
  onOpen,
}: {
  surface: CmuxSurface;
  agent?: AgentState;
  now: number;
  lastInWorkspace: boolean;
  onOpen: () => void;
}) {
  const { closeSurface } = useAppStore();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const kind = surface.agent ?? agent?.agent ?? null;
  const kindLabel = kind ? AGENT_DISPLAY_NAME[kind] : surface.type === "terminal" ? "Shell" : surface.type;
  const tone = agent ? STATUS_TONE[agent.status] : "status-idle";
  const glyph = agent ? STATUS_GLYPH[agent.status] : kind ? "○" : "·";
  const timing = agent
    ? agent.status === "WORKING" && agent.turnStartedAt
      ? formatDuration(now - agent.turnStartedAt)
      : formatAgo(agent.lastActivityAt, now)
    : "";

  const close = async () => {
    if (busy || lastInWorkspace) return;
    if (!armed) {
      setArmed(true);
      setNote(null);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await closeSurface(surface.id);
    } catch (caught) {
      setNote(`没关掉：${caught instanceof Error ? caught.message : String(caught)}`);
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`surface-row ${agent ? "" : "muted"}`}>
      <button type="button" className="surface-open" onClick={onOpen}>
        <span className={`surface-glyph ${tone}`}>{glyph}</span>
        <span className="surface-main">
          <span className="surface-title">{surface.title}</span>
          <span className="surface-meta">
            {kindLabel}
            {agent ? ` · ${STATUS_LABEL[agent.status]}` : ""}
            {agent?.currentActivity ? ` · ${agent.currentActivity}` : ""}
          </span>
        </span>
        <span className="surface-side">
          {timing ? <span>{timing}</span> : null}
        </span>
      </button>
      <button
        type="button"
        className={`surface-close${armed ? " armed" : ""}`}
        disabled={busy || lastInWorkspace}
        title={
          lastInWorkspace
            ? "这是这个 workspace 最后一个 tab，cmux 不允许关掉"
            : armed
              ? "再点一次确认关掉（进程会一起没）"
              : "关闭这个 surface"
        }
        aria-label={lastInWorkspace ? "无法关闭最后一个 surface" : armed ? "确认关闭" : "关闭"}
        onClick={() => void close()}
      >
        {armed ? "确认关?" : "×"}
      </button>
      {note ? <div className="surface-close-note">{note}</div> : null}
    </div>
  );
}
