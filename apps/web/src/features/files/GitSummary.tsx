import type { GitStatus } from "@car/protocol";
import type { GitTab } from "./GitPanel.tsx";

export function GitSummary({ repo, open, compact, onOpen, onToggle }: {
  repo: GitStatus; open: boolean; compact: boolean; onOpen: (tab: GitTab) => void; onToggle: () => void;
}) {
  const conflicts = repo.changes.filter(change => change.conflict).length;
  const state = conflicts ? "conflict" : repo.changes.length ? "changed" : "clean";
  const changeLabel = conflicts ? `${conflicts} 个冲突` : repo.changes.length ? `${repo.changes.length} 项变更` : "工作区干净";
  const remoteLabel = repo.fetch.running ? "远程更新中…" : repo.fetch.error ? "远程未更新" : repo.fetch.succeededAt ? "远程已更新" : "本地缓存";
  return <div className={`git-summary${compact ? " compact" : ""}`} onKeyDown={event => event.stopPropagation()}>
    <button className="git-summary-repo" title={repo.root} aria-label={`查看仓库概览：${repo.root}`} onClick={() => onOpen("overview")}>{repo.root.split("/").pop()}</button>
    <div className="git-summary-details">
      <button className="git-summary-branch" title={repo.branch} aria-label={`查看分支：${repo.branch}`} onClick={() => onOpen("branches")}>{repo.branch}</button>
      <button className={`git-summary-changes ${state}`} aria-label={`查看变更：${changeLabel}`} onClick={() => onOpen("changes")}>{changeLabel}</button>
      {repo.upstream && <button className="git-summary-sync" title={`${repo.upstream} · 领先 ${repo.ahead}，落后 ${repo.behind} 个提交`} aria-label={`查看同步概览：领先 ${repo.ahead}，落后 ${repo.behind} 个提交`} onClick={() => onOpen("overview")}>↑{repo.ahead} ↓{repo.behind}</button>}
    </div>
    <button className={`git-summary-remote${repo.fetch.error ? " warning" : ""}`} title={repo.fetch.error || (repo.fetch.succeededAt ? `上次成功更新：${new Date(repo.fetch.succeededAt).toLocaleString()}` : remoteLabel)} onClick={() => onOpen("overview")}>{remoteLabel}</button>
    <button className="git-summary-toggle" aria-expanded={open} aria-label={open ? "收起 Git 信息" : "展开 Git 概览"} onClick={onToggle}>{open ? "收起" : "展开"}<span aria-hidden="true">{open ? "▴" : "▾"}</span></button>
  </div>;
}
