import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FileError } from "./files.ts";

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Raw request bodies are streamed to a private staging directory, published only on success. */
export async function saveUpload(dataDir: string, request: Request, limit = MAX_UPLOAD_BYTES) {
  const name = request.headers.get("x-file-name");
  let filename: string;
  try { filename = decodeURIComponent(name ?? ""); } catch { throw new FileError("无效文件名"); }
  if (!filename || filename === "." || filename === ".." || /[/\\\x00-\x1f\x7f]/.test(filename) || Buffer.byteLength(filename) > 255) throw new FileError("文件名无效或过长");
  const surfaceId = request.headers.get("x-surface-id") ?? "";
  if (!surfaceId || surfaceId.length > 200 || /[\x00-\x1f]/.test(surfaceId)) throw new FileError("缺少有效会话标识");
  const size = Number(request.headers.get("x-file-size"));
  if (!request.headers.has("x-file-size") || !Number.isSafeInteger(size) || size < 0) throw new FileError("无效文件大小");
  if (size > limit) throw new FileError("单个文件上传上限为 512 MB", 413);
  const id = randomUUID();
  const parent = resolve(dataDir, "uploads", new Date().toISOString().slice(0, 10));
  const staging = join(parent, `.upload-${id}`);
  const directory = join(parent, id);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    // Metadata stays outside the payload folder, preserving any original filename.
    const payload = join(staging, "file");
    const handle = await open(payload, "wx", 0o600);
    const reader = request.body?.getReader();
    let written = 0;
    try {
      while (reader) {
        request.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > limit) throw new FileError("单个文件上传上限为 512 MB", 413);
        if (written > size) throw new FileError("上传大小与声明不一致");
        let offset = 0;
        while (offset < value.byteLength) offset += (await handle.write(value, offset, value.byteLength - offset)).bytesWritten;
      }
      request.signal.throwIfAborted();
      if (written !== size) throw new FileError("上传未完成，请重试");
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); await handle.close(); }
    await mkdir(join(staging, "payload"));
    await rename(payload, join(staging, "payload", filename));
    await writeFile(join(staging, "metadata.json"), JSON.stringify({ id, name: filename, size, surfaceId, uploadedAt: new Date().toISOString() }), { mode: 0o600 });
    // Final layout: <id>/<original name>; association is a sibling metadata file.
    await rename(join(staging, "payload"), directory);
    await rename(join(staging, "metadata.json"), join(parent, `${id}.json`));
    return { id, name: filename, path: join(directory, filename), size };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { await rm(staging, { recursive: true, force: true }); }
}
