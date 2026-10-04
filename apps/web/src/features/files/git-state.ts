import { createContext, useContext, useEffect, useState } from "react";
import type { GitStatus, GitMark, GitChange } from "@car/protocol";
import { request } from "../../api.ts";
export const GitContext = createContext<GitStatus | null>(null);
export const markLabels: Record<GitMark, string> = { ignored: "已忽略", untracked: "未跟踪", unstaged: "未暂存修改", staged: "已暂存修改", added: "新增", deleted: "删除", updated: "冲突" };
// git.yazi CODES priority: ignored files do not bubble up.
const priority: Record<GitMark, number> = { updated: 1, deleted: 2, added: 3, staged: 4, unstaged: 5, untracked: 6, ignored: 7 };
export function pathMark(repo: GitStatus | null, path: string): GitMark | null {
  if (!repo || !path.startsWith(repo.root + "/")) return null;
  const rel = path.slice(repo.root.length + 1);
  if (repo.ignored.some(p => rel === p.replace(/\/$/, "") || (p.endsWith("/") && rel.startsWith(p)))) return "ignored";
  let mark: GitMark | null = null;
  for (const c of repo.changes) {
    if (c.path === rel || c.path.startsWith(rel + "/")) if (!mark || priority[c.mark] > priority[mark]) mark = c.mark;
  }
  return mark;
}
export function usePathMark(path: string) { return pathMark(useContext(GitContext), path); }
export const groups = ["conflict", "unstaged", "staged", "untracked"] as const;
export type ChangeGroup = typeof groups[number];
export const groupLabels: Record<ChangeGroup, string> = { conflict: "冲突", unstaged: "未暂存", staged: "已暂存", untracked: "未跟踪" };
export function inGroup(c: GitChange, group: ChangeGroup) {
  if (group === "conflict") return c.conflict;
  if (c.conflict) return false;
  if (group === "untracked") return c.index === "?";
  if (c.index === "?") return false;
  return group === "staged" ? c.index !== " " : c.worktree !== " ";
}
export const gitGet = <T,>(endpoint: string, path: string, params: Record<string, string> = {}, signal?: AbortSignal) => request<T>(`/api/git/${endpoint}?${new URLSearchParams({ path, ...params })}`, { signal });
export function useGitStatus(path: string | undefined, revision: number) {
  const [repo, setRepo] = useState<GitStatus | null>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setRepo(prev => prev && path && (path === prev.root || path.startsWith(prev.root + "/")) ? prev : null); setError(""); if (!path) return;
    const abort = new AbortController(); let reading = false; let fetching = false;
    const load = async () => {
      if (reading || document.hidden) return; reading = true; setLoading(true);
      try {
        const result = await gitGet<GitStatus | null>("status", path, {}, abort.signal);
        if (abort.signal.aborted) return;
        setRepo(result); setError("");
        if (result && !fetching) {
          fetching = true;
          setRepo({ ...result, fetch: { ...result.fetch, running: true } });
          void request("/api/git/fetch", { method: "POST", body: JSON.stringify({ path: result.root }), signal: abort.signal })
            .then(async () => { const updated = await gitGet<GitStatus>("status", path, {}, abort.signal); if (!abort.signal.aborted) setRepo(updated); })
            .catch(e => { if (!abort.signal.aborted) setRepo(prev => prev && ({ ...prev, fetch: { ...prev.fetch, running: false, error: e.message } })); });
        }
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
      finally { reading = false; if (!abort.signal.aborted) setLoading(false); }
    };
    void load(); const timer = setInterval(load, 10000);
    const visible = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { abort.abort(); clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [path, revision, refresh]);
  const fetchNow = async () => {
    if (!repo || repo.fetch.running) return;
    setRepo({ ...repo, fetch: { ...repo.fetch, running: true } });
    try { await request("/api/git/fetch", { method: "POST", body: JSON.stringify({ path: repo.root, force: true }) }); }
    catch (e) { setError((e as Error).message); }
    finally { setRefresh(v => v + 1); }
  };
  return { repo, error, loading, fetchNow };
}
