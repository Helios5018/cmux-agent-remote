import { useEffect, useRef, useState } from "react";
import type { CmuxPane, CmuxWorkspace } from "@car/protocol";
import { useAppStore } from "../../stores/AppStore.tsx";

export type WorkspaceCloseTarget = { workspace: CmuxWorkspace; mode: "workspace" | "pane" };

export function WorkspaceCloseDialog({ target, onDismiss, onWorkspaceClosed }: {
  target: WorkspaceCloseTarget;
  onDismiss: () => void;
  onWorkspaceClosed: (id: string) => void;
}) {
  const { closeWorkspace, closePane } = useAppStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [pane, setPane] = useState<CmuxPane | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { workspace, mode } = target;
  const choosing = mode === "pane" && !pane;
  const surfaces = pane ? pane.surfaces : workspace.panes.flatMap(p => p.surfaces);
  const paneLabel = (p: CmuxPane) => `分屏 ${workspace.panes.findIndex(item => item === p) + 1} · ${p.ref}`;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { cancel.current?.focus(); }, [pane]);

  const close = async () => {
    if (inFlight.current || choosing) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const ids = surfaces.map(s => s.id);
      if (pane) await closePane(workspace.id, pane.id ?? pane.ref, ids);
      else await closeWorkspace(workspace.id, ids);
      onDismiss();
      if (!pane) onWorkspaceClosed(workspace.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "关闭失败，请刷新后重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <dialog ref={dialog} className="rename-dialog workspace-close-dialog"
    aria-labelledby="workspace-close-title" aria-describedby="workspace-close-description"
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <h2 id="workspace-close-title">{choosing ? "选择要关闭的 pane" : pane ? "确认关闭 pane？" : "确认关闭 workspace？"}</h2>
    <p className="close-target-name">{workspace.title} <span className="dim">{workspace.ref}</span></p>
    {choosing ? <>
      <p id="workspace-close-description">按分屏编号和终端名称辨认。选择后还需确认。</p>
      <div className="pane-close-options">
        {workspace.panes.map(p => <button key={p.id ?? p.ref} type="button"
          disabled={workspace.panes.length <= 1} onClick={() => setPane(p)}>
          <strong>{paneLabel(p)}{p.focused ? " · 焦点" : ""}</strong>
          <span>{p.surfaces.length} 个 surface</span>
          {p.surfaces.map(s => <span key={s.id}>{s.title} <span className="dim">{s.ref}</span></span>)}
        </button>)}
      </div>
      {workspace.panes.length <= 1 ? <p>这是最后一个 pane。如需全部关闭，请使用“关闭 workspace”。</p> : null}
    </> : <>
      {pane ? <p><strong>{paneLabel(pane)}</strong></p> : null}
      <p id="workspace-close-description">{pane ? "将关闭这个 pane" : `将关闭整个 workspace，包括全部 ${workspace.panes.length} 个 pane`}及其中的 {surfaces.length} 个 surface。正在运行的 Agent 和命令将被终止，未保存内容可能丢失，无法撤销。</p>
      <ul className="close-surface-list">{surfaces.map(s => <li key={s.id}>{s.title} <span className="dim">{s.ref}</span></li>)}</ul>
    </>}
    {error ? <p role="alert" className="close-error">{error}</p> : null}
    <div className="rename-dialog-actions">
      <button ref={cancel} type="button" className="ghost-button" disabled={busy} onClick={onDismiss}>取消</button>
      {pane ? <button type="button" className="ghost-button" disabled={busy} onClick={() => { setPane(null); setError(null); }}>重新选择</button> : null}
      {!choosing ? <button type="button" className="ghost-button danger-action" disabled={busy || !!error}
        onClick={() => void close()}>{busy ? "正在关闭…" : pane ? "确认关闭 pane" : "确认关闭 workspace"}</button> : null}
    </div>
  </dialog>;
}
