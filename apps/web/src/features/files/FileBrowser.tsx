import { GitContext, useGitStatus } from "./git-state.ts";
import { GitSummary } from "./GitSummary.tsx";
import { GitPanel, type GitTab } from "./GitPanel.tsx";
import { FileEntryContent, formatFileSize as size } from "./FileEntryContent.tsx";
import { useDesktopInput } from "../../hooks/useDesktopInput.ts";
import { useElementWidth } from "../../hooks/useElementWidth.ts";
import { ParentDirectory } from "./ParentDirectory.tsx";
import { DeleteFilesDialog } from "./DeleteFilesDialog.tsx";
import { MediaPreview } from "./MediaPreview.tsx";
import { PathBreadcrumbs } from "./PathBreadcrumbs.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FileEntry, FileListing, FileOperation, FilePreview, FileMutationResult } from "@car/protocol";
import { request } from "../../api.ts";
import { useFiles } from "./state.ts";
import "./files.css";
const leaf = (path: string) => path.split("/").filter(Boolean).pop() || "/";
export function FileBrowser({ scopeId, onClose, workDirectory, onInsert }: { scopeId: string; onInsert?: (paths: string[]) => void; onClose: () => void; workDirectory?: () => Promise<string | null> }) {
  const { ref: browserRef, width: browserWidth } = useElementWidth<HTMLElement>();
  const desktopInput = useDesktopInput();
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const visual = useRef<{ anchor: string; base: string[]; unset: boolean } | null>(null);
  const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const threeColumns = browserWidth >= 900;
  const { state, getFiles, setFiles, patchTab, addTab } = useFiles(scopeId); const tab = state.tabs.find((t) => t.id === state.active);
  const [roots, setRoots] = useState<string[]>([]);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const focusedEntry = listing?.entries.find((e) => e.path === focusedPath) ?? listing?.entries[0];
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false); const [writing, setWriting] = useState(false);
  const [revision, setRevision] = useState(0); const [menu, setMenu] = useState(false);
  const git = useGitStatus(tab?.path, revision);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitTab, setGitTab] = useState<GitTab>("overview");
  const openGit = (next: GitTab) => { setGitTab(next); setGitOpen(true); };
  useEffect(() => { setGitOpen(false); }, [git.repo?.root]);
  const [home, setHome] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const selectionMode = !!onInsert || selecting || !!tab?.selected.length;
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2500); return () => clearTimeout(timer); }, [notice]);
  const [deleteMode, setDeleteMode] = useState<"trash" | "permanent">("permanent");
  const [deletePaths, setDeletePaths] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<{ action: "file" | "directory" | "rename"; name: string; path?: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null); const requestRef = useRef<AbortController>();
  const previewRequest = useRef<AbortController>(); const writeLock = useRef(false);
  const touch = useRef<{ x: number; y: number }>(); const longPress = useRef<ReturnType<typeof setTimeout>>(); const held = useRef(false);
  useEffect(() => { const abort = new AbortController(); request<{ roots: string[]; home?: string }>("/api/files/roots", { signal: abort.signal }).then((r) => {
    setHome(r.home ?? ""); setRoots(r.roots); if (!getFiles().tabs.length && r.roots[0]) {
      if (workDirectory) void workDirectory().then((p) => { if (!abort.signal.aborted && !getFiles().tabs.length) addTab(p ?? (r.home || r.roots[0]!)); }).catch(() => { if (!abort.signal.aborted && !getFiles().tabs.length) addTab((r.home || r.roots[0]!)); });
      else addTab(r.home || r.roots[0]);
    }
  }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }); return () => { abort.abort(); requestRef.current?.abort(); previewRequest.current?.abort(); clearTimeout(longPress.current); }; }, []);
  useEffect(() => { if (dialog) dialogRef.current?.showModal(); }, [dialog?.action]);
  const load = async (more = false) => {
    if (!tab) return;
    requestRef.current?.abort(); const abort = new AbortController(); requestRef.current = abort;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ path: tab.path, q: tab.query, mode: tab.mode, hidden: tab.hidden ? "1" : "0" });
      const first = more ? listing?.next ?? 0 : 0;
      let result: FileListing | null = null;
      let offset: number | null = first;
      const desired = more ? first + 100 : Math.max(100, tab.loaded || 100);
      while (offset !== null && offset < desired) {
        params.set("offset", String(offset));
        const page: FileListing = await request<FileListing>(`/api/files/list?${params}`, { signal: abort.signal });
        result = { ...page, entries: [...((result as FileListing | null)?.entries ?? []), ...page.entries] }; offset = page.next;
      }
      if (abort.signal.aborted || !result) return;
      setListing(more ? { ...result, entries: [...(listing?.entries ?? []), ...result.entries] } : result);
      if (more) patchTab(tab.id, { loaded: desired });
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    setListing(null); setPreview(null); previewRequest.current?.abort();
    const timer = setTimeout(() => void load(), tab?.query ? 250 : 0);
    return () => { clearTimeout(timer); requestRef.current?.abort(); };
  }, [tab?.id, tab?.path, tab?.query, tab?.mode, tab?.hidden, revision]);
  useLayoutEffect(() => { if (listRef.current && tab && listing) listRef.current.scrollTop = tab.scroll; }, [listing, tab?.id]);
  const focusMemory = useRef<Record<string, string>>({});
  const keyboardNavigation = useRef(false);
  useLayoutEffect(() => {
    if (!desktopInput || !listing || !keyboardNavigation.current) return;
    keyboardNavigation.current = false;
    const index = Math.max(0, listing.entries.findIndex((entry) => entry.path === focusedEntry?.path));
    const entry = listRef.current?.querySelectorAll<HTMLButtonElement>(".file-entry")[index];
    if (entry) entry.focus(); else browserRef.current?.focus();
  }, [listing, desktopInput]);
  const navigate = (path: string) => { keyboardNavigation.current = desktopInput; visual.current = null; if (tab && focusedEntry) focusMemory.current[tab.path] = focusedEntry.path; setFocusedPath(focusMemory.current[path] ?? null); setSelecting(false); if (tab) patchTab(tab.id, { path, scroll: 0, selected: [], query: "", loaded: 100 }); };
  const toggle = (path: string) => { if (tab) patchTab(tab.id, { selected: tab.selected.includes(path) ? tab.selected.filter((p) => p !== path) : [...tab.selected, path] }); };
  const showPreview = async (entry: FileEntry) => {
    if (held.current) { held.current = false; return; }
    if (selectionMode && !onInsert) { toggle(entry.path); return; }
    if (entry.kind === "directory") { navigate(entry.path); return; }
    if (threeColumns) {
      if (!listing?.entries.some((e) => e.path === entry.path)) navigate(entry.path.slice(0, entry.path.lastIndexOf("/")) || "/");
      setFocusedPath(entry.path); return;
    }
    previewRequest.current?.abort(); const abort = new AbortController(); previewRequest.current = abort;
    setPreview(null); setError("");
    try { const p = await request<FilePreview>(`/api/files/preview?${new URLSearchParams({ path: entry.path })}`, { signal: abort.signal }); if (!abort.signal.aborted) setPreview(p); } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
  };
  useEffect(() => {
    if (!threeColumns) return;
    previewRequest.current?.abort(); setPreview(null);
    if (!focusedEntry || focusedEntry.kind === "directory") return;
    const abort = new AbortController(); previewRequest.current = abort;
    const timer = setTimeout(() => {
      void request<FilePreview>(`/api/files/preview?${new URLSearchParams({ path: focusedEntry.path })}`, { signal: abort.signal })
        .then((p) => { if (!abort.signal.aborted) setPreview(p); })
        .catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    }, 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [threeColumns, focusedEntry?.path, revision]);
  const wasThreeColumns = useRef(threeColumns);
  useEffect(() => { if (wasThreeColumns.current && !threeColumns) setPreview(null); wasThreeColumns.current = threeColumns; }, [threeColumns]);
  const operate = async (op: FileOperation) => {
    if (writeLock.current) return; writeLock.current = true; setWriting(true); setError(""); setNotice("");
    try { const result = await request<FileMutationResult>("/api/files/operation", { method: "POST", body: JSON.stringify(op) });
      if (op.action === "move") {
        const current = getFiles();
        if (current.clipboardMode === "move") setFiles({ ...current, clipboard: current.clipboard.filter((p) => !result.paths.some((done) => p === done || p.startsWith(done + "/"))) });
      }
      if (result.failed?.length) setError(result.failed.map((f) => `${leaf(f.path)}：${f.message}`).join("；"));
      setNotice(result.ok ? "操作完成" : `已完成 ${result.paths.length} 项，未完成项目已保留`); setDialog(null); dialogRef.current?.close(); setRevision((n) => n + 1); if (tab) patchTab(tab.id, { selected: [] }); }
    catch (e) { setError((e as Error).message); setRevision((n) => n + 1); }
    finally { writeLock.current = false; setWriting(false); }
  };
  const copyPath = async (paths: string[]) => { try { await navigator.clipboard.writeText(paths.join("\n")); setError(""); setNotice("路径已复制"); } catch { setError(`浏览器未允许复制，路径：${paths.join("、")}`); } };
  const switchTab = (direction: number) => { const i = state.tabs.findIndex((t) => t.id === state.active); const next = state.tabs[i + direction]; if (next) setFiles({ ...getFiles(), active: next.id }); };
  const targets = () => tab?.selected.length ? tab.selected : focusedEntry ? [focusedEntry.path] : [];
  const insertPaths = (paths: string[]) => {
    if (onInsert) onInsert(paths);
    else {
      const event = new CustomEvent("car:insert-files", { cancelable: true, detail: { surfaceId: scopeId, paths } });
      window.dispatchEvent(event);
      if (!event.defaultPrevented) { setError("当前输入暂不可编辑，请先回到会话核对发送状态"); return; }
    }
    setNotice("已插入当前会话输入框");
  };
  const yank = (mode: "copy" | "move") => {
    const paths = targets(); if (!paths.length || !tab) return;
    setFiles({ ...getFiles(), clipboard: paths, clipboardMode: mode });
    patchTab(tab.id, { selected: [] }); visual.current = null; setSelecting(false);
    setNotice(mode === "move" ? "已剪切，进入目标目录后按 p 移动" : "已复制，进入目标目录后按 p 粘贴");
  };
  const moveCursor = (delta: number) => {
    if (!threeColumns) setPreview(null);
    const entries = listing?.entries ?? []; if (!entries.length || !tab) return;
    const from = Math.max(0, entries.findIndex((entry) => entry.path === focusedEntry?.path));
    const index = Math.max(0, Math.min(entries.length - 1, from + delta));
    const next = entries[index]!;
    if (visual.current) {
      const anchor = Math.max(0, entries.findIndex((entry) => entry.path === visual.current!.anchor));
      const range = entries.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((entry) => entry.path);
      patchTab(tab.id, { selected: visual.current.unset ? visual.current.base.filter((p) => !range.includes(p)) : [...new Set([...visual.current.base, ...range])] });
    }
    setFocusedPath(next.path);
    listRef.current?.querySelectorAll<HTMLButtonElement>(".file-entry")[index]?.focus();
  };
  const onShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!desktopInput || event.nativeEvent.isComposing || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], dialog, audio, video')) return;
    if (menu || shortcutHelp) { if (event.key === "Escape") { setMenu(false); setShortcutHelp(false); } return; }
    if (!tab || writing || deletePaths || dialog) return;
    const key = event.key;
    if (event.ctrlKey) {
      if (key === "a" || key === "r") {
        event.preventDefault(); const paths = listing?.entries.map((e) => e.path) ?? [];
        visual.current = null; setSelecting(true);
        patchTab(tab.id, { selected: key === "a" ? paths : paths.filter((p) => !tab.selected.includes(p)) });
      }
      return;
    }
    if (["ArrowUp", "k", "ArrowDown", "j"].includes(key)) { event.preventDefault(); moveCursor(key === "ArrowUp" || key === "k" ? -1 : 1); return; }
    const supported = ["ArrowLeft", "h", "ArrowRight", "l", "Enter", "o", " ", "v", "V", "Escape", "y", "x", "p", "Y", "X", "d", "D", ".", "r", "f", "~", "F1"];
    if (!supported.includes(key)) return;
    if (key === "Enter" && target.closest("button") && !target.closest(".file-entry")) return;
    event.preventDefault(); if (event.repeat) return;
    if (key === "ArrowLeft" || key === "h") { if (preview && !threeColumns) setPreview(null); else if (tab.path !== "/") { keyboardNavigation.current = true; navigate(parentPath(tab.path)); } }
    else if (["ArrowRight", "l", "Enter", "o"].includes(key)) {
      if (focusedEntry) {
        if (focusedEntry.kind === "directory") { keyboardNavigation.current = true; navigate(focusedEntry.path); }
        else if (threeColumns) setFocusedPath(focusedEntry.path);
        else { previewRequest.current?.abort(); const abort = new AbortController(); previewRequest.current = abort; void request<FilePreview>(`/api/files/preview?${new URLSearchParams({path:focusedEntry.path})}`, {signal:abort.signal}).then((p) => { if (!abort.signal.aborted) setPreview(p); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }); }
      }
    }
    else if (key === " ") { if (focusedEntry) { visual.current = null; setSelecting(true); toggle(focusedEntry.path); } }
    else if (key === "v" || key === "V") { if (focusedEntry) { visual.current = { anchor: focusedEntry.path, base: [...tab.selected], unset: key === "V" }; setSelecting(true); patchTab(tab.id, { selected: key === "V" ? tab.selected.filter((p) => p !== focusedEntry.path) : [...new Set([...tab.selected, focusedEntry.path])] }); } }
    else if (key === "Escape") { visual.current = null; setSelecting(false); patchTab(tab.id, {selected:[]}); if (!threeColumns) setPreview(null); }
    else if (key === "y" || key === "x") yank(key === "x" ? "move" : "copy");
    else if (key === "p") { if (state.clipboard.length) void operate({action:state.clipboardMode ?? "copy",paths:state.clipboard,directory:tab.path}); }
    else if (key === "Y" || key === "X") setFiles({...getFiles(),clipboard:[],clipboardMode:"copy"});
    else if (key === "d" || key === "D") { if (targets().length) { setDeleteMode(key === "d" ? "trash" : "permanent"); setDeletePaths([...targets()]); } }
    else if (key === ".") patchTab(tab.id,{hidden:!tab.hidden,loaded:100,scroll:0});
    else if (key === "r") { if (targets().length === 1) setDialog({action:"rename",path:targets()[0]!,name:leaf(targets()[0]!)}); }
    else if (key === "f") setSearchOpen(true);
    else setShortcutHelp(true);
  };
  return <GitContext.Provider value={git.error ? null : git.repo}><section ref={browserRef} tabIndex={0} onKeyDown={gitOpen ? undefined : onShortcut} className={`file-browser${threeColumns ? " three-columns" : " one-column"}`} aria-label="文件系统">
    {state.tabs.length > 1 && <div className="file-tabs file-directory-tabs" role="tablist" aria-label="目录标签">{state.tabs.map((t) => <button role="tab" aria-selected={t.id === state.active} key={t.id} onClick={() => setFiles({ ...getFiles(), active: t.id })}>{leaf(t.path)}</button>)}</div>}
    <div className="file-toolbar">
      <button disabled={!listing?.parent} aria-label="返回上级目录" onClick={() => listing?.parent && navigate(listing.parent)}>↑</button>
      <PathBreadcrumbs path={tab?.path ?? "/"} home={home} roots={roots} onNavigate={navigate} />
      {!!state.clipboard.length && !selectionMode && <button disabled={writing || !tab} className="file-paste" onClick={() => tab && void operate({ action: state.clipboardMode ?? "copy", paths: state.clipboard, directory: tab.path })}>{writing ? "处理中…" : `${state.clipboardMode === "move" ? "移动到此处" : "粘贴"} ${state.clipboard.length}`}</button>}
      <button aria-label="搜索" aria-expanded={searchOpen || !!tab?.query} onClick={() => { const open = searchOpen || !!tab?.query; setSearchOpen(!open); if (open && tab) patchTab(tab.id, { query: "", loaded: 100, scroll: 0 }); }}>⌕</button>
      <div className="file-menu" ref={menuRef}><button aria-label="文件系统更多操作" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>{menu && <div className="file-menu-panel">
        <button className="file-menu-create" disabled={!tab || writing} onClick={() => { setMenu(false); setError(""); setDialog({ action: "file", name: "" }); }}>新建文件</button>
        <button className="file-menu-create" disabled={!tab || writing} onClick={() => { setMenu(false); setError(""); setDialog({ action: "directory", name: "" }); }}>新建文件夹</button>
        <button className="file-menu-organize file-menu-divider" onClick={() => { setMenu(false); setSelecting(true); }}>选择文件</button>
        <button className="file-menu-organize" disabled={!tab} onClick={() => { setMenu(false); if (tab) void copyPath([tab.path]); }}>复制当前目录路径</button>
        <button className="file-menu-browse file-menu-divider" onClick={() => { setMenu(false); setRevision((n) => n + 1); }}>刷新文件列表</button>
        <button className="file-menu-browse" aria-pressed={tab?.hidden ?? false} onClick={() => { setMenu(false); if (tab) patchTab(tab.id, { hidden: !tab.hidden, loaded: 100, scroll: 0 }); }}>{tab?.hidden ? "不显示隐藏文件" : "显示隐藏文件"}</button>
        <button className="file-menu-browse" disabled={!tab} onClick={() => { setMenu(false); if (tab) addTab(tab.path); }}>新增目录标签</button>
        {!!state.clipboard.length && <button className="file-menu-muted" onClick={() => { setFiles({ ...getFiles(), clipboard: [], clipboardMode: "copy" }); setMenu(false); }}>清空剪贴板</button>}
        {workDirectory && <button className="file-menu-browse" onClick={() => { setMenu(false); void workDirectory().then((p) => p ? navigate(p) : setError("未找到 Agent 工作目录，可从主目录继续浏览")).catch((e) => setError(e.message)); }}>转到当前 Agent 工作目录</button>}
        {state.tabs.length > 1 && <button className="file-menu-close" onClick={() => { const remaining = state.tabs.filter((t) => t.id !== state.active); setFiles({ ...state, tabs: remaining, active: remaining[0]!.id }); setMenu(false); }}>关闭当前目录标签</button>}
        {!!home && <button className="file-menu-browse" onClick={() => { setMenu(false); navigate(home); }}>主目录 ~</button>}
        {desktopInput && <button className="file-menu-browse" onClick={() => { setMenu(false); setShortcutHelp(true); }}>快捷键说明</button>}
        <button className="file-menu-close file-menu-divider" onClick={onClose}>关闭文件系统</button>
      </div>}</div>
    </div>
    {git.error ? <div className="git-summary git-summary-error" role="status">Git 状态读取失败：{git.error}</div> : git.repo ? <GitSummary repo={git.repo} open={gitOpen} compact={browserWidth < 650} onOpen={openGit} onToggle={() => gitOpen ? setGitOpen(false) : openGit("overview")} /> : git.loading && <div className="git-summary git-muted">正在读取 Git 状态…</div>}
    {gitOpen && git.repo && <GitPanel key={git.repo.root} repo={git.repo} tab={gitTab} onTabChange={setGitTab} onFetch={() => void git.fetchNow()} />}
    {!gitOpen && (searchOpen || !!tab?.query) && <div className="file-search"><select aria-label="搜索范围" value={tab?.mode ?? "filter"} onChange={(e) => tab && patchTab(tab.id, { mode: e.target.value, loaded: 100, scroll: 0 })}><option value="filter">当前目录</option><option value="name">递归找文件</option><option value="content">搜索内容</option></select>
      <input autoFocus aria-label="搜索文件" placeholder="搜索…" value={tab?.query ?? ""} onChange={(e) => tab && patchTab(tab.id, { query: e.target.value, selected: [], loaded: 100, scroll: 0 })} />
      <button onClick={() => { requestRef.current?.abort(); setBusy(false); setSearchOpen(false); if (tab) patchTab(tab.id, { query: "", scroll: 0, loaded: 100 }); }}>取消</button>
    </div>}
    {error && <div className="file-message error" role="alert">{error}</div>}{notice && <div className="file-toast" role="status">{notice}</div>}
    <div style={gitOpen ? { display: "none" } : undefined} className={`file-body${preview ? " has-preview" : ""}`}>
      {threeColumns && <ParentDirectory path={tab?.path && tab.path !== "/" ? tab.path.slice(0, tab.path.lastIndexOf("/")) || "/" : null} current={tab?.path ?? ""} hidden={tab?.hidden ?? true} onPromote={() => tab && navigate(parentPath(tab.path))} onNavigate={() => tab && navigate(parentPath(tab.path))} onOpen={(entry) => { if (tab) { navigate(parentPath(tab.path)); setFocusedPath(entry.path); } }} />}
      <div className="file-list" ref={listRef} onScroll={(e) => { if (tab) patchTab(tab.id, { scroll: e.currentTarget.scrollTop }); }}
        onTouchStart={(e) => { const p = e.touches[0]; if (p) touch.current = { x: p.clientX, y: p.clientY }; }}
        onTouchMove={(e) => { const p = e.touches[0]; if (p && touch.current && Math.hypot(p.clientX-touch.current.x, p.clientY-touch.current.y) > 10) clearTimeout(longPress.current); }}
        onTouchEnd={(e) => { clearTimeout(longPress.current); const p = e.changedTouches[0]; if (touch.current && p) { const dx = p.clientX-touch.current.x; const dy = p.clientY-touch.current.y; if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy)*2) switchTab(dx > 0 ? -1 : 1); } touch.current = undefined; }}>
        {threeColumns && <div className="file-column-heading">当前目录</div>}
        {listing?.entries.map((entry) => <div className={`file-row${desktopInput && focusedEntry?.path === entry.path ? " focused" : ""}${tab?.selected.includes(entry.path) ? " selected" : ""}${state.clipboardMode === "move" && state.clipboard.includes(entry.path) ? " cut" : ""}`} key={entry.path}>
          {selectionMode && (!onInsert || entry.kind === "file") && <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={tab?.selected.includes(entry.path) ?? false} onChange={() => toggle(entry.path)} />}
          <button className="file-entry" draggable={entry.kind === "file"} onDragStart={event => {
            const paths = tab?.selected.includes(entry.path) ? tab.selected : [entry.path];
            event.dataTransfer.setData("application/x-car-files", JSON.stringify(paths));
            event.dataTransfer.setData("text/plain", paths.join("\n"));
            event.dataTransfer.effectAllowed = "copy";
          }} tabIndex={desktopInput ? (focusedEntry?.path === entry.path ? 0 : -1) : 0}
            onPointerEnter={(e) => { if (threeColumns && e.pointerType === "mouse") setFocusedPath(entry.path); }}
            onFocus={() => { if (desktopInput) setFocusedPath(entry.path); }}
 onClick={() => {
              if (held.current) { held.current = false; return; }
              if (selectionMode && !onInsert) { toggle(entry.path); return; }
              setFocusedPath(entry.path);
              if (!threeColumns) void showPreview(entry);
            }} onContextMenu={(e) => { e.preventDefault(); toggle(entry.path); }}
            onPointerDown={(e) => { held.current = false; if (e.pointerType === "touch") longPress.current = setTimeout(() => { held.current = true; toggle(entry.path); }, 500); }} onPointerUp={() => clearTimeout(longPress.current)} onPointerCancel={() => clearTimeout(longPress.current)}>
            <FileEntryContent entry={entry} detail={entry.excerpt ? `L${entry.line} · ${entry.excerpt}` : tab?.mode !== "filter" && tab?.query ? entry.path : undefined} />
          </button>
        </div>)}
        {busy && <p className="file-empty">正在查找…</p>}{!busy && listing && !listing.entries.length && <p className="file-empty">{tab?.query ? "没有匹配的文件" : "这个文件夹是空的"}</p>}
        {listing?.limited && <p className="file-empty">搜索达到时间或数量上限，请进入更具体的目录继续查找。内容搜索仅检查 128 KB 以内的文本，跳过 .git 和 node_modules。</p>}
        {listing?.next !== null && listing?.next !== undefined && <button className="file-more" disabled={busy} onClick={() => void load(true)}>加载更多文件</button>}
      </div>
      {threeColumns && focusedEntry?.kind === "directory" && <ParentDirectory key={focusedEntry.path} path={focusedEntry.path} current="" hidden={tab?.hidden ?? true} title={focusedEntry.name} className="file-child file-preview" onPromote={() => navigate(focusedEntry.path)} onNavigate={navigate} onOpen={(entry) => { navigate(focusedEntry.path); setFocusedPath(entry.path); }} />}
      {threeColumns && focusedEntry?.kind !== "directory" && !preview && <aside className="file-preview file-preview-placeholder" aria-label="文件预览"><div className="file-column-heading">{focusedEntry?.name ?? "当前项"}</div><p className="file-empty">{focusedEntry ? "正在读取…" : "这个文件夹是空的"}</p></aside>}
      {preview && (!threeColumns || focusedEntry?.kind !== "directory") && <aside className="file-preview" aria-label="文件预览"><div className="file-preview-header"><strong>{preview.name}</strong>{!threeColumns && <button aria-label="关闭预览" onClick={() => { setPreview(null); if (desktopInput) browserRef.current?.focus(); }}>×</button>}</div><div className="file-actions"><span>{size(preview.size)}</span><button onClick={() => insertPaths([preview.path])}>插入当前会话</button><button onClick={() => void copyPath([preview.path])}>复制路径</button>{preview.size <= 20*1024*1024 && <a href={`/api/files/download?${new URLSearchParams({ path: preview.path })}`} download={preview.name}>下载</a>}</div>
        {preview.kind === "video" || preview.kind === "audio" ? <MediaPreview key={preview.path} preview={preview} /> : preview.kind === "image" ? <img alt={preview.name} src={`/api/files/download?${new URLSearchParams({ path: preview.path, inline: "1" })}`} /> : preview.kind === "text" ? <pre>{preview.text}</pre> : <p>此格式暂不支持预览。</p>}{preview.truncated && <p>仅预览前 128 KB。</p>}
      </aside>}
    </div>
    {onInsert && <div className="file-selection"><span>已选 {tab?.selected.length ?? 0} 项</span><button disabled={!tab?.selected.length} onClick={() => { if (tab) { insertPaths(tab.selected); patchTab(tab.id, { selected: [] }); } }}>插入所选文件</button><button onClick={onClose}>取消</button></div>}
    {!onInsert && selectionMode && <div className="file-selection"><div className="file-selection-heading"><span>已选 {tab?.selected.length ?? 0} 项</span><button onClick={() => tab && patchTab(tab.id, { selected: listing?.entries.map((e) => e.path) ?? [] })}>全选</button><button onClick={() => { setSelecting(false); if (tab) patchTab(tab.id, { selected: [] }); }}>完成</button></div><div className="file-selection-actions"><button disabled={!tab?.selected.length} onClick={() => tab && insertPaths(tab.selected)}>插入当前会话</button><button disabled={!tab?.selected.length} onClick={() => { setFiles({ ...getFiles(), clipboard: tab!.selected, clipboardMode: "copy" }); patchTab(tab!.id, { selected: [] }); setSelecting(false); setNotice("已复制，进入目标目录后粘贴"); }}>复制</button><button disabled={!tab?.selected.length || writing} onClick={() => { setFiles({ ...getFiles(), clipboard: tab!.selected, clipboardMode: "move" }); patchTab(tab!.id, { selected: [] }); setSelecting(false); setNotice("已剪切，进入目标目录后移动到此处"); }}>剪切</button><button disabled={!tab?.selected.length} onClick={() => tab && void copyPath(tab.selected)}>复制地址</button><button disabled={tab?.selected.length !== 1 || writing} onClick={() => tab && setDialog({ action: "rename", path: tab.selected[0]!, name: leaf(tab.selected[0]!) })}>重命名</button><button className="file-delete-button" disabled={!tab?.selected.length || writing} onClick={() => { if (tab) { setDeleteMode("permanent"); setDeletePaths([...tab.selected]); } }}>删除</button></div></div>}
    {shortcutHelp && <div className="file-shortcuts" role="region" aria-label="文件快捷键"><button onClick={() => { setShortcutHelp(false); browserRef.current?.focus(); }}>关闭</button><p>↑ ↓ / k j：移动 · ← → / h l：返回 / 进入 · Enter：进入或预览</p><p>Space：多选 · v / V：连续选择 / 取消 · Ctrl+A：全选已加载项 · Ctrl+R：反选 · Esc：取消选择</p><p>y：复制 · x：剪切 · p：粘贴 · Y / X：清空剪贴板</p><p>d：移到废纸篓（一次确认） · D：永久删除（两次确认） · r：重命名 · .：隐藏文件 · f：筛选</p><p>快捷键仅在电脑文件区获得焦点时生效。输入框与 Agent 会话不受影响。</p></div>}
    {deletePaths && <DeleteFilesDialog mode={deleteMode} paths={deletePaths} onClose={() => { setDeletePaths(null); if (desktopInput) browserRef.current?.focus(); }} onDeleted={(result) => {
      const current = getFiles();
      const removed = (p: string) => result.paths.some((done) => p === done || p.startsWith(done + "/"));
      setFiles({ ...current, clipboard: current.clipboard.filter((p) => !removed(p)), tabs: current.tabs.map((t) => ({ ...t, selected: t.selected.filter((p) => !removed(p)) })) });
      setSelecting(false); setPreview(null); setRevision((n) => n + 1);
      setNotice(`已删除 ${result.paths.length} 项`);
      setError(result.failed?.map((f) => `${leaf(f.path)}：${f.message}`).join("；") ?? "");
    }} />}
    <dialog ref={dialogRef} className="rename-dialog" aria-label="文件操作" onCancel={() => setDialog(null)} onClose={() => { setDialog(null); if (desktopInput) browserRef.current?.focus(); }}>{dialog && <form onSubmit={(e) => { e.preventDefault(); if (!tab) return; void operate(dialog.action === "rename" ? { action: "rename", path: dialog.path!, name: dialog.name } : { action: "create", directory: tab.path, name: dialog.name, kind: dialog.action }); }}><h2>{dialog.action === "rename" ? "重命名" : dialog.action === "file" ? "新建文件" : "新建文件夹"}</h2><label>名称<input autoFocus value={dialog.name} maxLength={255} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} /></label>{error && <p role="alert">{error}</p>}<div className="rename-dialog-actions"><button type="button" disabled={writing} onClick={() => dialogRef.current?.close()}>取消</button><button type="submit" disabled={writing || !dialog.name.trim()}>{writing ? "处理中…" : "保存"}</button></div></form>}</dialog>
  </section></GitContext.Provider>;
}
