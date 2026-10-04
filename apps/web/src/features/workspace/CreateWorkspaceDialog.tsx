import { useEffect, useRef, useState } from "react";
import type { AgentKind, CreateWorkspaceResponse, FileListing } from "@car/protocol";
import { ApiError, request } from "../../api.ts";
import { useAppStore } from "../../stores/AppStore.tsx";
import type { Route } from "../../hooks/useRouter.ts";
import "./create-workspace.css";

export function CreateWorkspaceDialog({ onDismiss, onCreated, navigate }: {
  onDismiss: () => void; onCreated: (id: string) => void; navigate: (route: Route) => void;
}) {
  const { createWorkspace } = useAppStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const controller = useRef<AbortController>();
  const [listing, setListing] = useState<FileListing | null>(null);
  const [path, setPath] = useState("");
  const [home, setHome] = useState("");
  const [step, setStep] = useState<"directory" | "agent">("directory");
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [created, setCreated] = useState<CreateWorkspaceResponse | null>(null);

  async function browse(directory: string, offset = 0) {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError("");
    if (!offset) setListing(null);
    try {
      const page = await request<FileListing>(`/api/files/list?${new URLSearchParams({ path: directory, hidden: "1", offset: String(offset) })}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setListing(previous => offset && previous?.path === page.path ? { ...page, entries: [...previous.entries, ...page.entries] } : page);
      setPath(page.path);
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "读取目录失败");
    } finally { if (!abort.signal.aborted) setLoading(false); }
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const abort = new AbortController();
    void request<{ home: string }>("/api/files/roots", { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted) { setHome(result.home); void browse(result.home); }
    }).catch(caught => { if (!abort.signal.aborted) { setError(caught.message); setLoading(false); } });
    return () => { abort.abort(); controller.current?.abort(); if (previous?.isConnected) previous.focus(); };
  }, []);

  async function submit() {
    if (pending.current || !listing || created || uncertain) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await createWorkspace({ cwd: listing.path, launch: agent });
      setCreated(result); onCreated(result.workspaceId);
      if (!result.launchError) { onDismiss(); navigate({ name: "session", surfaceId: result.surfaceId }); }
    } catch (caught) {
      const rejected = caught instanceof ApiError && [400, 401, 403, 404, 429].includes(caught.status);
      setUncertain(!rejected);
      setError(rejected ? caught.message : "创建结果未知，请关闭弹窗并检查结构树，确认后再尝试创建。");
    }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="rename-dialog create-workspace-dialog" aria-labelledby="create-workspace-title"
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <h2 id="create-workspace-title">{step === "directory" ? "1 · 选择工作目录" : "2 · 选择 Agent"}</h2>
    {step === "directory" ? <>
      <p>选择这台 Mac 上的文件夹，作为新 workspace 的工作目录。</p>
      <form className="workspace-path" onSubmit={event => { event.preventDefault(); void browse(path); }}>
        <input aria-label="目录路径" value={path} placeholder="输入绝对目录路径" onChange={event => setPath(event.target.value)} />
        <button disabled={loading || !path.startsWith("/")}>前往</button>
      </form>
      <div className="rename-dialog-actions">
        <button disabled={loading || !listing?.parent} onClick={() => listing?.parent && void browse(listing.parent)}>上一级</button>
        <button disabled={loading || !home} onClick={() => void browse(home)}>主目录</button>
      </div>
      <div className="workspace-directories" aria-label="文件夹列表" aria-busy={loading}>
        {listing?.entries.filter(entry => entry.kind === "directory" || entry.kind === "link").map(entry =>
          <button key={entry.path} disabled={loading} onClick={() => void browse(entry.path)}>📁 {entry.name}<span>›</span></button>)}
        {loading && <p role="status">正在读取…</p>}
        {!loading && listing && !listing.entries.some(entry => entry.kind === "directory" || entry.kind === "link") && <p>没有子文件夹，可以选择当前目录。</p>}
        {listing?.next != null && <button disabled={loading} onClick={() => void browse(listing.path, listing.next!)}>加载更多</button>}
      </div>
      <p className="workspace-selected-path">当前目录：{listing?.path ?? "尚未选择"}</p>
    </> : <>
      <p className="workspace-selected-path">工作目录：{listing?.path}</p>
      <label>Agent<select value={agent} disabled={busy || !!created} onChange={event => setAgent(event.target.value as AgentKind)}>
        <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="grok">Grok</option><option value="pi">Pi</option>
      </select></label>
    </>}
    {error && <p role="alert">{error}</p>}
    {created?.launchError && <p role="alert">{created.launchError}</p>}
    <div className="rename-dialog-actions">
      <button disabled={busy} onClick={onDismiss}>{created ? "关闭" : "取消"}</button>
      {created ? <button onClick={() => { onDismiss(); navigate({ name: "session", surfaceId: created.surfaceId }); }}>打开会话检查</button>
        : step === "directory" ? <button disabled={loading || !listing || path !== listing.path} onClick={() => { setError(""); setStep("agent"); }}>选择此目录，下一步</button>
        : <><button disabled={busy} onClick={() => setStep("directory")}>上一步</button><button disabled={busy || uncertain} onClick={() => void submit()}>{busy ? "正在创建…" : "创建并启动"}</button></>}
    </div>
  </dialog>;
}
