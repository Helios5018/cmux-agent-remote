import { usePathMark } from "./git-state.ts";
import { GitMark } from "./GitMark.tsx";
import type { FileEntry } from "@car/protocol";

type FileStyle = "folder" | "code" | "config" | "image" | "video" | "audio" | "archive" | "pdf" | "document" | "sheet" | "link" | "file";
export function fileStyle(entry: Pick<FileEntry, "name" | "kind">): FileStyle {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "link") return "link";
  const name = entry.name.toLowerCase(); const ext = name.split(".").pop() ?? "";
  if (["png","jpg","jpeg","webp","gif","avif","svg","heic","ico","bmp","tiff"].includes(ext)) return "image";
  if (["mp4","mov","m4v","webm","mkv","avi","ogv"].includes(ext)) return "video";
  if (["mp3","wav","m4a","ogg","opus","aac","flac","aiff"].includes(ext)) return "audio";
  if (["zip","tar","gz","bz2","xz","7z","rar","dmg"].includes(ext)) return "archive";
  if (ext === "pdf") return "pdf";
  if (["csv","tsv","xls","xlsx","numbers"].includes(ext)) return "sheet";
  if (["json","jsonc","yaml","yml","toml","ini","env","lock","xml","conf"].includes(ext) || /^(\.git|\.env|dockerfile|makefile)/.test(name)) return "config";
  if (["ts","tsx","js","jsx","mjs","cjs","py","go","rs","java","c","cpp","h","swift","sh","zsh","bash","css","scss","html","sql","rb","php","vue","svelte"].includes(ext)) return "code";
  if (["md","mdx","txt","rtf","doc","docx","pages"].includes(ext)) return "document";
  return "file";
}
export function FileIcon({ style }: { style: FileStyle }) {
  const marks = {
    code: <><path d="m8 8-3 3 3 3m4-6 3 3-3 3" /></>,
    config: <><path d="M6 8h8M6 12h8M8 6v4m4 0v4" /></>,
    image: <><circle cx="7" cy="7" r="1" /><path d="m4 15 4-4 3 3 2-2 3 3" /></>,
    video: <path d="m8 7 5 3-5 3Z" fill="currentColor" stroke="none" />,
    audio: <><path d="M10 13V6l4-1v6" /><ellipse cx="8" cy="13" rx="2" ry="1.5" /><ellipse cx="12" cy="11" rx="2" ry="1.5" /></>,
    archive: <><path d="M10 4v8m-1-6h2m-2 3h2" /><rect x="8.5" y="12" width="3" height="3" rx=".5" /></>,
    pdf: <><path d="M6 14V7h3a2 2 0 0 1 0 4H6m6 3h2" /></>,
    document: <path d="M6 7h7M6 10h7M6 13h4" />,
    sheet: <><path d="M4 8h12M4 12h12M9 5v11" /></>,
    link: <><path d="m8 12 4-4m-6 2-1 1a3 3 0 0 0 4 4l2-2m-2-6 2-2a3 3 0 0 1 4 4l-1 1" /></>,
    file: <path d="M6 8h5M6 11h7" />,
    folder: null,
  };
  return <span className={`file-icon file-icon-${style}`} aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    {style === "folder" ? <><path d="M2 5a1.5 1.5 0 0 1 1.5-1.5H8l2 2h6.5A1.5 1.5 0 0 1 18 7v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15Z" fill="currentColor" fillOpacity=".18" /><path d="M2 7h16" /></>
      : <>{style !== "link" && <rect x="3" y="2" width="14" height="16" rx="2" strokeOpacity=".5" />}{marks[style]}</>}
  </svg></span>;
}
export function formatFileSize(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
export function FileEntryContent({ entry, detail }: { entry: FileEntry; detail?: string }) {
  const mark = usePathMark(entry.path);
  return <><FileIcon style={fileStyle(entry)} /><span className="file-name">{entry.name}{detail && <small>{detail}</small>}</span>{entry.kind === "file" && <span className="file-entry-meta">{formatFileSize(entry.size)}</span>}<GitMark mark={mark} /></>;
}
