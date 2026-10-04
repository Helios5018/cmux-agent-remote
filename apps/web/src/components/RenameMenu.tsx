import { useEffect, useRef, useState } from "react";

export function RenameMenu({ value, onRename, maxLength = 80, label = "名称", placeholder, createLabel, onCreate, closeActions, fileAction }: {
  fileAction?: { label: string; run: () => void };
  closeActions?: { workspace: () => void; pane: () => void };
  createLabel?: string;
  onCreate?: () => Promise<unknown>;
  value: string;
  onRename: (name: string) => void;
  maxLength?: number;
  label?: string;
  placeholder?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    action.current?.focus();
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    // 触摸浏览器可能在 click 前 blur，且 relatedTarget 为 null。
    // 不能在 blur 时卸载菜单项，否则这次点击无法打开改名弹窗。
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);

  return (
    <div className="rename-menu" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button ref={trigger} type="button" className="more-button" aria-label={`${value}的更多操作`}
        aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open ? <div className="rename-menu-panel">
        <button ref={action} type="button" onClick={() => {
          setDraft(value);
          setOpen(false);
          dialog.current?.showModal();
          input.current?.focus();
          input.current?.select();
        }}>重命名</button>
        {fileAction ? <button type="button" onClick={() => { setOpen(false); fileAction.run(); }}>{fileAction.label}</button> : null}
        {onCreate ? <button type="button" disabled={creating} onClick={async () => {
          if (inFlight.current) return;
          inFlight.current = true;
          setCreating(true);
          setCreateError(null);
          try {
            await onCreate();
            setOpen(false);
            trigger.current?.focus();
          } catch (error) {
            setCreateError(error instanceof Error ? error.message : "创建失败，请重试");
          } finally {
            inFlight.current = false;
            setCreating(false);
          }
        }}>{creating ? "正在创建…" : createLabel}</button> : null}
        {closeActions ? <div className="workspace-danger-actions">
          <button type="button" disabled={creating} onClick={() => { trigger.current?.focus(); setOpen(false); closeActions.pane(); }}>关闭 pane…</button>
          <button type="button" className="danger-action" disabled={creating} onClick={() => { trigger.current?.focus(); setOpen(false); closeActions.workspace(); }}>关闭 workspace…</button>
        </div> : null}
        {createError ? <div role="alert">{createError}</div> : null}
      </div> : null}
      <dialog ref={dialog} className="rename-dialog" aria-label={`修改${label}`}
        onClose={() => trigger.current?.focus()}>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          if (draft.trim() !== value) onRename(draft.trim());
          dialog.current?.close();
        }}>
          <h2>重命名</h2>
          <label>{label}
            <input ref={input} value={draft} maxLength={maxLength} placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
              }} />
          </label>
          <div className="rename-dialog-actions">
            <button type="button" className="ghost-button" onClick={() => dialog.current?.close()}>取消</button>
            <button type="submit" className="ghost-button" disabled={!draft.trim()}>保存</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
