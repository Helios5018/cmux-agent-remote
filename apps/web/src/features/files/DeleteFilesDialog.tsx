import { useEffect, useRef, useState } from "react";
import type { FileMutationResult } from "@car/protocol";
import { request } from "../../api.ts";

export function DeleteFilesDialog({ paths, onClose, onDeleted, mode = "permanent" }: {
  mode?: "trash" | "permanent"; paths: string[]; onClose: () => void; onDeleted: (result: FileMutationResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<FileMutationResult | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async () => {
    if (lock.current || (plan && confirmation !== "删除")) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await request<FileMutationResult>("/api/files/operation", { method: "POST", body: JSON.stringify(plan ? { action: "delete", token: plan.token, confirm: true } : { action: "delete_prepare", paths, mode }) });
      if (!plan && mode === "trash") {
        const deleted = await request<FileMutationResult>("/api/files/operation", { method: "POST", body: JSON.stringify({ action: "delete", token: result.token, confirm: true }) });
        onDeleted(deleted); onClose();
      } else if (!plan) setPlan(result);
      else { onDeleted(result); onClose(); }
    } catch (e) { setError((e as Error).message); setPlan(null); setConfirmation(""); }
    finally { lock.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="rename-dialog file-delete-dialog" aria-label="删除文件确认" onCancel={(e) => { if (busy) e.preventDefault(); else onClose(); }}>
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>{plan ? "最后确认" : mode === "trash" ? "确认移到废纸篓？" : "确认删除这些项目？"}</h2>
      <p className="file-delete-warning">{mode === "trash" ? `将以下 ${(plan?.paths ?? paths).length} 项移到 Mac 废纸篓，可在 Finder 中恢复。` : `将永久删除以下 ${(plan?.paths ?? paths).length} 项，包含文件夹内容，不会进入废纸篓。`}</p>
      <ul className="file-delete-list">{(plan?.paths ?? paths).map((path) => <li key={path}>{path}</li>)}</ul>
      {plan && <label>输入“删除”完成第二次确认<input aria-label="第二次删除确认" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}
      <div className="rename-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="file-delete-button" type="submit" disabled={busy || (!!plan && confirmation !== "删除")}>{busy ? "处理中…" : mode === "trash" ? "移到废纸篓" : plan ? "永久删除" : "确认，继续"}</button></div>
    </form>
  </dialog>;
}
