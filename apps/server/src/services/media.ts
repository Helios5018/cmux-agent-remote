import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { FileError } from "./files.ts";

export const mediaTypes: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
};

/** Byte ranges let native players seek without loading an entire large file into memory. */
export async function mediaResponse(path: string, request: Request): Promise<Response> {
  const mime = mediaTypes[extname(path).toLowerCase()];
  if (!mime) throw new FileError("此格式不支持音视频播放");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileError("只能播放普通文件");
    const headers = new Headers({ "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" });
    let start = 0; let end = info.size - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = !!match && !!(match[1] || match[2]) && info.size > 0;
      if (valid && match) {
        if (!match[1]) { const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0; start = Math.max(0, info.size - suffix); }
        else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < info.size; }
      }
      if (!valid) { headers.set("Content-Range", `bytes */${info.size}`); await close(); return new Response(null, { status: 416, headers }); }
      headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
    }
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (request.method === "HEAD" || info.size === 0) { await close(); return new Response(null, { status: range ? 206 : 200, headers }); }
    let position = start;
    const abort = () => { void close(); };
    request.signal.addEventListener("abort", abort, { once: true });
    const finish = async () => { request.signal.removeEventListener("abort", abort); await close(); };
    if (request.signal.aborted) await finish();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (closed || position > end) { await finish(); controller.close(); return; }
          const buffer = Buffer.alloc(Math.min(64 * 1024, end - position + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) { await finish(); controller.error(new Error("文件在播放时发生变化，请重新打开")); return; }
          position += bytesRead; controller.enqueue(buffer.subarray(0, bytesRead));
          if (position > end) { await finish(); controller.close(); }
        } catch (error) { await finish(); controller.error(error); }
      },
      cancel: finish,
    });
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch (error) { await close(); throw error; }
}
