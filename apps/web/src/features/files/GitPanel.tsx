import { useEffect, useState } from "react";
import type { GitStatus, GitBranch, GitHistory, GitCommitDetail, GitDiff, GitChange } from "@car/protocol";
import { gitGet, groups, groupLabels, inGroup, type ChangeGroup } from "./git-state.ts";
import { GitMark } from "./GitMark.tsx";
import "./git.css";
const date = (value: string | number) => new Date(value).toLocaleString();
type Selection = { file: string; mode: "staged" | "unstaged" | "untracked" | "commit"; ref?: string; label: string };
export type GitTab = "overview" | "changes" | "branches" | "history";
export function GitPanel({ repo, onFetch, tab, onTabChange }: { repo: GitStatus; onFetch: () => void; tab: GitTab; onTabChange: (tab: GitTab) => void }) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [history, setHistory] = useState<GitHistory>({ commits: [], next: null }); const [ref, setRef] = useState("HEAD");
  const [offset, setOffset] = useState(0); const [commitId, setCommitId] = useState("");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null); const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [contentView, setContentView] = useState(false);
  useEffect(() => { setContentView(false); }, [selection]);
  const [diffError, setDiffError] = useState("");
  useEffect(() => {
    const abort = new AbortController(); setError(""); setBusy(true);
    const load = async () => {
      if (tab === "branches") setBranches(await gitGet<GitBranch[]>("branches", repo.root, {}, abort.signal));
      if (tab === "history") {
        const result = await gitGet<GitHistory>("history", repo.root, { ref, offset: String(offset) }, abort.signal);
        if (!abort.signal.aborted) setHistory(prev => ({ ...result, commits: offset ? [...prev.commits.slice(0, offset), ...result.commits] : result.commits }));
      }
    };
    void load().catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [tab, repo.root, repo.oid, repo.fetch.succeededAt, ref, offset]);
  useEffect(() => {
    setDetail(null); if (!commitId) return;
    const abort = new AbortController();
    void gitGet<GitCommitDetail>("commit", repo.root, { ref: commitId }, abort.signal).then(result => { if (!abort.signal.aborted) setDetail(result); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [commitId, repo.root]);
  useEffect(() => {
    setDiff(null); setDiffError(""); if (!selection) return;
    const abort = new AbortController();
    void gitGet<GitDiff>(contentView ? "content" : "diff", repo.root, { file: selection.file, mode: selection.mode, ...(selection.ref ? { ref: selection.ref } : {}) }, abort.signal)
      .then(result => { if (!abort.signal.aborted) setDiff(result); }).catch(e => { if (!abort.signal.aborted) setDiffError(e.message); });
    return () => abort.abort();
  }, [selection, contentView, repo.root, repo.oid, repo.changes]);
  useEffect(() => { setSelection(null); setCommitId(""); setError(""); }, [tab]);
  const changeTab = (value: GitTab) => { onTabChange(value); setSelection(null); setCommitId(""); setError(""); };
  const selectChange = (c: GitChange, group: ChangeGroup) => setSelection({ file: c.path, mode: group === "conflict" ? "unstaged" : group, label: groupLabels[group] });
  return <div className="git-panel" onKeyDown={e => e.stopPropagation()}>
    <div className="git-tabs" role="tablist" aria-label="Git 信息">{[["overview", "概览"], ["changes", `变更 ${repo.changes.length}`], ["branches", "分支"], ["history", "提交"]].map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => changeTab(value as GitTab)}>{label}</button>)}</div>
    {error && <p className="file-message error" role="alert">{error}</p>}
    <div className={`git-content${selection ? " with-diff" : ""}`}>
      <div className="git-main">
        {tab === "overview" && <div className="git-overview">
          <strong>{repo.root.split("/").pop()}</strong><p className="git-muted git-wrap">{repo.root}</p>
          <dl><dt>当前分支</dt><dd>{repo.branch}{!repo.oid && " · 尚无提交"}</dd><dt>上游</dt><dd>{repo.upstream ?? "未配置上游"}</dd>
            <dt>同步状态</dt><dd>{repo.upstream ? `领先 ${repo.ahead} · 落后 ${repo.behind} 个提交` : "无上游可比较"}</dd><dt>工作状态</dt><dd>{repo.operation ? `正在 ${repo.operation}` : repo.changes.length ? `${repo.changes.length} 个文件有变更` : "工作区干净"}</dd></dl>
          <div className="git-counts">{groups.map(g => <button key={g} onClick={() => changeTab("changes")}>{groupLabels[g]} <strong>{repo.changes.filter(c => inGroup(c, g)).length}</strong></button>)}</div>
          <div className="git-fetch"><p>{repo.fetch.running ? "正在后台更新远程信息…" : repo.fetch.error ? "远程更新失败，当前为本地缓存" : "远程信息基于本地缓存"}</p>
            <p className="git-muted">{repo.fetch.remote && `${repo.fetch.remote} · `}{repo.fetch.succeededAt ? `上次成功更新：${date(repo.fetch.succeededAt)}` : "尚无本应用成功更新记录"}</p>
            {repo.fetch.error && <details><summary>查看原因</summary><pre>{repo.fetch.error}</pre></details>}
            <button disabled={repo.fetch.running} onClick={onFetch}>刷新远程信息</button>
          </div>
        </div>}
        {tab === "changes" && <><p className="git-muted">整个仓库 · 工作区与暂存区</p>{!repo.changes.length && <p>工作区干净</p>}{groups.map(group => {
          const items = repo.changes.filter(c => inGroup(c, group));
          return items.length > 0 && <section key={group}><h3>{groupLabels[group]} · {items.length}</h3>{items.map(c => <button className="git-row" key={c.path} onClick={() => selectChange(c, group)}><GitMark mark={group === "staged" && c.mark === "unstaged" ? "staged" : c.mark} /><span>{c.path}{c.originalPath && <small>从 {c.originalPath} 重命名</small>}{c.conflict && <small>冲突待解决</small>}</span></button>)}</section>;
        })}</>}
        {tab === "branches" && <><p className="git-muted">点击分支查看提交历史；当前检出：{repo.branch}</p>{[false, true].map(remote => <section key={String(remote)}><h3>{remote ? "远程分支 · 本地缓存" : "本地分支"}</h3>{branches.filter(b => b.remote === remote).map(b => <button key={b.ref} className="git-row" onClick={() => { setRef(b.ref); setOffset(0); setHistory({ commits: [], next: null }); changeTab("history"); }}><span>{b.name}{b.current && <b className="git-current">当前</b>}<small>{b.upstream ? `上游 ${b.upstream} ${b.tracking} · ` : ""}{b.oid.slice(0, 8)} · {b.subject}</small><small>{date(b.date)}</small></span></button>)}{!busy && !branches.some(b => b.remote === remote) && <p className="git-muted">暂无{remote ? "远程" : "本地"}分支</p>}</section>)}</>}
        {tab === "history" && <>
          <div className="git-history-heading"><span>正在查看：{ref === "HEAD" ? repo.branch : ref.replace(/^refs\/(heads|remotes)\//, "")}</span>{ref !== "HEAD" && <button onClick={() => { setRef("HEAD"); setOffset(0); setCommitId(""); setSelection(null); }}>回到当前分支</button>}</div>
          {commitId ? <><button onClick={() => { setCommitId(""); setSelection(null); }}>← 返回提交列表</button>{detail ? <><h3>{detail.commit.subject}</h3><p className="git-muted git-wrap">{detail.commit.oid}<br />{detail.commit.author} · {date(detail.commit.date)}</p><pre className="git-message">{detail.commit.message}</pre><p className="git-muted">{detail.parent ? "与第一父提交比较" : "首次提交"} · {detail.files.length} 个文件</p>{detail.files.map(f => <button key={f.path} className="git-row" onClick={() => setSelection({ file: f.path, mode: "commit", ref: detail.commit.oid, label: `提交 ${detail.commit.oid.slice(0, 8)}` })}><GitMark mark={f.status.startsWith("A") ? "added" : f.status.startsWith("D") ? "deleted" : "staged"} /><span>{f.path}{f.originalPath && <small>{f.originalPath} → {f.path}</small>}</span></button>)}</> : <p>正在读取提交…</p>}</>
          : <>{history.commits.map(c => <button key={c.oid} className="git-row" onClick={() => setCommitId(c.oid)}><span>{c.subject}<small>{c.oid.slice(0, 8)} · {c.author} · {date(c.date)}</small></span></button>)}{!busy && !history.commits.length && <p>暂无提交</p>}{history.next !== null && <button disabled={busy} onClick={() => setOffset(history.next!)}>加载更多提交</button>}</>}
        </>}
        {busy && <p className="git-muted">正在读取…</p>}
      </div>
      {selection && <aside className="git-diff" aria-label="Git 差异预览"><div className="git-diff-heading"><button onClick={() => setSelection(null)}>← 返回</button><strong>{selection.file}</strong><span>{selection.label}{selection.mode === "untracked" || contentView ? " · 文件内容" : " · Diff"}</span>{selection.mode !== "untracked" && <button onClick={() => setContentView(v => !v)}>{contentView ? "查看 Diff" : "查看文件内容"}</button>}</div>
        {diffError ? <p role="alert">{diffError}</p> : !diff ? <p>正在读取差异…</p> : <>{diff.binary && <p>二进制文件</p>}<pre>{diff.text ? diff.text.split("\n").map((line, i) => <span key={i} className={selection.mode === "untracked" || contentView ? "" : line.startsWith("+") ? "git-add" : line.startsWith("-") ? "git-delete" : line.startsWith("@@") ? "git-hunk" : ""}>{line || " "}</span>) : "没有可显示的文本差异"}</pre>{diff.truncated && <p>内容过大，仅显示前 256 KB。</p>}</>}
      </aside>}
    </div>
  </div>;
}
