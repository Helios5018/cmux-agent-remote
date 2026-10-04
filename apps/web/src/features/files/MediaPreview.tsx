import { useEffect, useRef, useState } from "react";
import type { FilePreview } from "@car/protocol";

export function MediaPreview({ preview }: { preview: FilePreview }) {
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => { const element = media.current; return () => { if (element) { element.pause(); element.removeAttribute("src"); element.load(); } }; }, []);
  const [failed, setFailed] = useState(false);
  const src = `/api/files/media?${new URLSearchParams({ path: preview.path })}`;
  return <div className="file-media">
    {preview.kind === "video" ? <video ref={(element) => { media.current = element; }} aria-label={`视频预览：${preview.name}`} controls playsInline preload="metadata" src={src} onError={() => setFailed(true)} />
      : <audio ref={(element) => { media.current = element; }} aria-label={`音频预览：${preview.name}`} controls preload="metadata" src={src} onError={() => setFailed(true)} />}
    {failed && <p role="alert">无法播放，可能是浏览器不支持此编码或文件已变化。可重新打开，或使用本机播放器。</p>}
  </div>;
}
