import type { DraftStore } from "../../stores/drafts.ts";
import type { FileReference } from "./model.ts";
const MAX_BYTES = 512 * 1024 * 1024;
const queues = new WeakMap<DraftStore, { jobs: (() => Promise<void>)[]; running: number }>();
/** Limit concurrent large transfers across all mounted/unmounted sessions. */
export function uploadReference(drafts: DraftStore, surfaceId: string, ref: FileReference) {
  let queue = queues.get(drafts);
  if (!queue) { queue = { jobs: [], running: 0 }; queues.set(drafts, queue); }
  const q = queue;
  const pump = () => {
    while (q.running < 2 && q.jobs.length) {
      q.running++;
      void q.jobs.shift()!().finally(() => { q.running--; pump(); });
    }
  };
  drafts.updateFile(surfaceId, ref.id, { status: "uploading", progress: 0, error: undefined });
  q.jobs.push(() => new Promise<void>(resolve => {
    if (!drafts.get(surfaceId).nodes?.some(n => n.type === "file" && n.id === ref.id)) { resolve(); return; }
    if (!ref.file || ref.file.size > MAX_BYTES) {
      drafts.updateFile(surfaceId, ref.id, { status: "error", error: ref.file ? "单个文件上限 512 MB" : "请重新选择文件" }); resolve(); return;
    }
    const xhr = new XMLHttpRequest();
    const unsubscribe = drafts.subscribe(surfaceId, () => {
      if (!drafts.get(surfaceId).nodes?.some(n => n.type === "file" && n.id === ref.id)) xhr.abort();
    });
    const finish = () => { unsubscribe(); resolve(); };
    try {
    xhr.open("POST", "/api/files/upload");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(ref.name));
    xhr.setRequestHeader("X-File-Size", String(ref.file.size));
    xhr.setRequestHeader("X-Surface-Id", surfaceId);
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) drafts.updateFile(surfaceId, ref.id, { progress: Math.min(99, Math.round(event.loaded / event.total * 100)) }); };
    xhr.onload = () => {
      let body: { path?: string; error?: { message?: string } } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* Proxy failures can return HTML. */ }
      if (xhr.status === 201 && typeof body.path === "string" && body.path.startsWith("/")) drafts.updateFile(surfaceId, ref.id, { status: "ready", path: body.path, progress: 100, file: undefined });
      else drafts.updateFile(surfaceId, ref.id, { status: "error", error: body.error?.message || `上传失败（${xhr.status}），可重试` });
      finish();
    };
    xhr.onerror = xhr.ontimeout = () => { drafts.updateFile(surfaceId, ref.id, { status: "error", error: "上传连接中断，可重试" }); finish(); };
    xhr.onabort = finish;
    xhr.send(ref.file);
    } catch {
      drafts.updateFile(surfaceId, ref.id, { status: "error", error: "无法读取或上传该文件，请重新选择" });
      finish();
    }
  }));
  pump();
}
