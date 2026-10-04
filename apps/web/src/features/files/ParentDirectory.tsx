import { FileEntryContent } from "./FileEntryContent.tsx";
import { useEffect, useRef, useState } from "react";
import type { FileEntry, FileListing } from "@car/protocol";
import { request } from "../../api.ts";

export function ParentDirectory({ path, current, hidden, onNavigate, title = "上级目录", className = "file-parent", onOpen, onPromote }: {
  onPromote?: () => void; title?: string; className?: string; onOpen?: (entry: FileEntry) => void;
  path: string | null; current: string; hidden: boolean; onNavigate: (path: string) => void;
}) {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const controller = useRef<AbortController>();
  const load = async (offset = 0) => {
    if (!path) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const result = await request<FileListing>(`/api/files/list?${new URLSearchParams({ path, hidden: hidden ? "1" : "0", offset: String(offset) })}`, { signal: abort.signal });
      if (!abort.signal.aborted) setListing((prev) => offset ? { ...result, entries: [...(prev?.entries ?? []), ...result.entries] } : result);
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  useEffect(() => { setListing(null); void load(); return () => controller.current?.abort(); }, [path, hidden]);
  return <aside className={className}
    onPointerDown={(e) => { pointerStart.current = { x: e.clientX, y: e.clientY }; }}
    onClick={(e) => {
      const target = e.target as HTMLElement;
      if (!path || !onPromote || target.closest("button, a, input") || target.closest("[role=alert]") || window.getSelection()?.toString()) return;
      const start = pointerStart.current; pointerStart.current = null;
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return;
      onPromote();
    }} aria-label={className.includes("file-child") ? "下级目录内容" : "上级目录"}>
    <div className="file-column-heading">{title}</div>
    {!path && <p className="file-empty">已到文件系统根目录</p>}
    {error && <p role="alert" className="file-empty">{error}</p>}
    {listing?.entries.map((entry) => <div key={entry.path} className={`file-row${entry.path === current ? " current" : ""}`}>
      <button className="file-entry" draggable={entry.kind === "file"} onDragStart={event => {
        event.dataTransfer.setData("application/x-car-files", JSON.stringify([entry.path]));
        event.dataTransfer.setData("text/plain", entry.path); event.dataTransfer.effectAllowed = "copy";
      }} aria-current={entry.path === current ? "location" : undefined} disabled={!onOpen && entry.kind !== "directory"} onClick={() => onOpen ? onOpen(entry) : onNavigate(entry.path)} title={entry.path}>
        <FileEntryContent entry={entry} />
      </button>
    </div>)}
    {listing && !listing.entries.length && !busy && <p className="file-empty">这个文件夹是空的</p>}
    {busy && <p className="file-empty">读取中…</p>}
    {listing?.next != null && <button className="file-more" disabled={busy} onClick={() => void load(listing.next!)}>加载更多</button>}
  </aside>;
}
