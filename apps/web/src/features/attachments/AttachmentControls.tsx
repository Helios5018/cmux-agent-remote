import { useEffect, useRef, useState } from "react";
import { request } from "../../api.ts";
import { FileBrowser } from "../files/FileBrowser.tsx";
import { MediaPreview } from "../files/MediaPreview.tsx";
import type { FilePreview } from "@car/protocol";
import type { FileReference } from "./model.ts";

export function AttachmentControls({ surfaceId, disabled, onFiles, onPaths }: {
  surfaceId: string; disabled: boolean; onFiles(files: File[]): void; onPaths(paths: string[]): void;
}) {
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const file = useRef<HTMLInputElement>(null); const media = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null); const dialog = useRef<HTMLDialogElement>(null);
  const closePicker = () => { dialog.current?.close(); setPicker(false); };
  useEffect(() => { if (picker) dialog.current?.showModal(); }, [picker]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node)) setMenu(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);
  return <div className="attachment-controls" ref={panel}>
    <button type="button" className="attachment-add" aria-label="添加文件" aria-expanded={menu} disabled={disabled} onClick={() => setMenu(!menu)}>＋</button>
    <input ref={media} type="file" multiple accept="image/*,video/*" hidden aria-label="照片与视频" onChange={e => { onFiles([...e.target.files ?? []]); e.target.value = ""; }} />
    <input ref={file} type="file" multiple hidden aria-label="上传文件" onChange={e => { onFiles([...e.target.files ?? []]); e.target.value = ""; }} />
    {menu && <div className="attachment-menu">
      <button type="button" onClick={() => { setMenu(false); media.current?.click(); }}>照片与视频</button>
      <button type="button" onClick={() => { setMenu(false); file.current?.click(); }}>上传文件</button>
      <button type="button" onClick={() => { setMenu(false); setPicker(true); }}>选择 Mac 文件</button>
      <small>上传文件单个上限 512 MB</small>
    </div>}
    {picker && <dialog ref={dialog} className="attachment-picker" aria-label="选择 Mac 文件" onCancel={closePicker} onClose={() => setPicker(false)}>
      <div className="attachment-dialog-header"><strong>选择 Mac 文件</strong><button type="button" aria-label="关闭文件选择" onClick={closePicker}>×</button></div>
      <FileBrowser scopeId={surfaceId} onClose={closePicker} onInsert={paths => { closePicker(); onPaths(paths); }}
        workDirectory={async () => (await request<{ path: string | null }>(`/api/agents/${encodeURIComponent(surfaceId)}/cwd`)).path} />
    </dialog>}
  </div>;
}

export function ReferenceDetails({ reference, disabled, onClose, onRemove, onRetry }: {
  reference: FileReference; disabled: boolean; onClose(): void; onRemove(): void; onRetry(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    setPreview(null); setError(""); if (!reference.path) return;
    const abort = new AbortController();
    void request<FilePreview>(`/api/files/preview?${new URLSearchParams({ path: reference.path })}`, { signal: abort.signal }).then(setPreview).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [reference.path]);
  return <dialog ref={dialog} className="reference-details" aria-label="文件引用" onCancel={onClose} onClose={onClose}>
    <div className="attachment-dialog-header"><strong>{reference.name}</strong><button type="button" aria-label="关闭文件引用" onClick={onClose}>×</button></div>
    {reference.path && <p className="reference-path">{reference.path}</p>}
    {reference.status === "uploading" && <p>正在上传 {reference.progress ?? 0}%</p>}
    {(reference.error || error) && <p role="alert">{reference.error || error}</p>}
    {preview?.kind === "image" && preview.size <= 20 * 1024 * 1024 && <img alt={preview.name} src={`/api/files/download?${new URLSearchParams({ path: preview.path, inline: "1" })}`} />}
    {preview && ["audio", "video"].includes(preview.kind) && <MediaPreview preview={preview} />}
    {preview?.kind === "text" && <pre>{preview.text}{preview.truncated ? "\n…预览已截断" : ""}</pre>}
    {preview && (preview.kind === "other" || preview.kind === "image" && preview.size > 20 * 1024 * 1024) && <p>文件可引用，当前格式或大小暂不支持预览。</p>}
    <div className="reference-actions">
      {reference.path && <button type="button" onClick={() => void navigator.clipboard.writeText(reference.path!).catch(() => setError("复制失败，可从上方选中路径复制"))}>复制路径</button>}
      {reference.status === "error" && <button type="button" disabled={disabled} onClick={onRetry}>重试上传</button>}
      <button type="button" disabled={disabled} onClick={() => { dialog.current?.close(); onRemove(); }}>移除引用</button>
    </div>
  </dialog>;
}
