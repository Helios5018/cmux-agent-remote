import { execFile } from "node:child_process";
import { realpath, stat, access, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitStatus, GitChange, GitMark, GitFetchState, GitBranch, GitHistory, GitDiff, GitCommitDetail } from "@car/protocol";

// Bounded, argument-array commands. Never invoke pagers, external diff drivers or prompts.
export function runGit(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["--no-optional-locks", "-c", "core.quotePath=false", "-c", "color.ui=false", ...args], {
    cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10", LC_ALL: "C" },
  }, (error, stdout, stderr) => error ? reject(new Error(error.killed ? "Git 请求超时" : stderr.trim() || error.message)) : resolve(stdout)));
}
export function gitMark(xy: string): GitMark {
  if (xy === "!!") return "ignored";
  if (xy === "??") return "untracked";
  if (/[MT]/.test(xy[1] ?? "")) return "unstaged";
  if (/[MT]/.test(xy[0] ?? "") && xy[1] === " ") return "staged";
  if (/[AC]/.test(xy)) return "added";
  if (/D/.test(xy)) return "deleted";
  if (/U/.test(xy)) return "updated";
  return xy[1] !== " " ? "unstaged" : "staged";
}
export function parseChanges(raw: string) {
  const changes: GitChange[] = []; const ignored: string[] = []; const records = raw.split("\0");
  for (let i = 0; i < records.length; i++) {
    const row = records[i]!; if (!row) continue;
    const xy = row.slice(0, 2); const path = row.slice(3);
    if (xy === "!!") { ignored.push(path); continue; }
    const originalPath = /[RC]/.test(xy) ? records[++i] : undefined;
    changes.push({ path, originalPath, index: xy[0]!, worktree: xy[1]!, conflict: ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy), mark: gitMark(xy) });
  }
  return { changes, ignored };
}
export class GitService {
  private fetches = new Map<string, GitFetchState>();
  private jobs = new Map<string, Promise<GitFetchState>>();
  async root(path: string): Promise<string | null> {
    if (!isAbsolute(path)) throw new Error("需要绝对目录路径");
    const cwd = await realpath(path); if (!(await stat(cwd)).isDirectory()) throw new Error("需要目录路径");
    try { return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trimEnd(); }
    catch (e) { if ((e as Error).message.includes("not a git repository")) return null; throw e; }
  }
  async requireRoot(path: string) { const root = await this.root(path); if (!root) throw new Error("当前目录不属于 Git 仓库"); return root; }
  private async optional(root: string, args: string[]) { try { return (await runGit(root, args)).trim(); } catch { return ""; } }
  /** Context only needs local summary; skip ignored files, upstream counts and fetch state. */
  async summary(path: string): Promise<{ root: string; branch: string; hasChanges: boolean } | null> {
    const root = await this.root(path);
    if (!root) return null;
    const [raw, head] = await Promise.all([
      runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"]),
      runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(async () =>
        runGit(root, ["symbolic-ref", "--short", "HEAD"])),
    ]);
    return { root, branch: head.trim(), hasChanges: raw.length > 0 };
  }

  async status(path: string): Promise<GitStatus | null> {
    const root = await this.root(path); if (!root) return null;
    const [raw, branch, oid, upstream, gitDir] = await Promise.all([
      runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]),
      this.optional(root, ["symbolic-ref", "--short", "HEAD"]), this.optional(root, ["rev-parse", "--verify", "HEAD"]),
      this.optional(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]), runGit(root, ["rev-parse", "--absolute-git-dir"]),
    ]);
    const counts = upstream && oid ? (await this.optional(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).split(/\s+/).map(Number) : [];
    let operation: string | null = null;
    for (const [file, label] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase / am"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"]]) {
      try { await access(resolve(gitDir.trimEnd(), file!)); operation = label!; break; } catch { /* absent */ }
    }
    return { root, branch: branch || `detached · ${oid.slice(0, 8)}`, oid: oid || null, upstream: upstream || null, ahead: counts[0] || 0, behind: counts[1] || 0, operation, ...parseChanges(raw), fetch: this.fetches.get(root) ?? { remote: null, running: false } };
  }
  async fetch(path: string, force = false): Promise<GitFetchState> {
    const root = await this.requireRoot(path);
    const running = this.jobs.get(root); if (running) return running;
    const previous = this.fetches.get(root);
    if (!force && previous?.attemptedAt && Date.now() - previous.attemptedAt < 300000) return previous;
    const job = this.performFetch(root, previous); this.jobs.set(root, job);
    try { return await job; } finally { this.jobs.delete(root); }
  }
  private async performFetch(root: string, previous?: GitFetchState): Promise<GitFetchState> {
    const state: GitFetchState = { remote: null, running: true, attemptedAt: Date.now(), succeededAt: previous?.succeededAt };
    this.fetches.set(root, state);
    try {
      const branch = await this.optional(root, ["symbolic-ref", "--short", "HEAD"]);
      const configured = branch ? await this.optional(root, ["config", "--get", `branch.${branch}.remote`]) : "";
      const remotes = (await runGit(root, ["remote"])).trim().split("\n").filter(Boolean);
      state.remote = configured && configured !== "." && remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : null;
      if (!state.remote) { state.error = remotes.length ? "未确定默认 remote，请配置分支上游" : "未配置远程仓库"; }
      else {
        // Explicit destination only updates remote-tracking refs, even with custom fetch refspecs.
        await runGit(root, ["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--", state.remote, `+refs/heads/*:refs/remotes/${state.remote}/*`], 30000);
        state.succeededAt = Date.now();
      }
    } catch (error) {
      state.error = (error as Error).message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1***@").slice(0, 1500);
    } finally { state.running = false; }
    return { ...state };
  }
  async branches(path: string): Promise<GitBranch[]> {
    const root = await this.requireRoot(path);
    const raw = await runGit(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)", "refs/heads", "refs/remotes"]);
    return raw.trimEnd().split("\n").filter(Boolean).flatMap(line => {
      const [ref, head, upstream, tracking, oid, subject, date, symbolic] = line.split("\0");
      if (symbolic) return [];
      return [{ ref: ref!, name: ref!.replace(/^refs\/(heads|remotes)\//, ""), remote: ref!.startsWith("refs/remotes/"), current: head === "*", upstream: upstream!, tracking: tracking!, oid: oid!, subject: subject!, date: date! }];
    });
  }
  private async revision(root: string, ref: string) {
    if (ref !== "HEAD" && !/^refs\/(heads|remotes)\//.test(ref) && !/^[a-f0-9]{40,64}$/.test(ref)) throw new Error("无效 Git 引用");
    return (await runGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  }
  async history(path: string, ref = "HEAD", offset = 0): Promise<GitHistory> {
    const root = await this.requireRoot(path);
    if (ref === "HEAD" && !(await this.optional(root, ["rev-parse", "--verify", "HEAD"]))) return { commits: [], next: null };
    const oid = await this.revision(root, ref);
    const raw = await runGit(root, ["log", "--format=%H%x00%s%x00%an%x00%aI", "-z", "-n", "51", `--skip=${offset}`, oid, "--"]);
    const fields = raw.split("\0"); const commits = [];
    for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ oid: fields[i]!, subject: fields[i+1]!, author: fields[i+2]!, date: fields[i+3]! });
    return { commits: commits.slice(0, 50), next: commits.length > 50 ? offset + 50 : null };
  }
  async commit(path: string, ref: string): Promise<GitCommitDetail> {
    const root = await this.requireRoot(path); const oid = await this.revision(root, ref);
    const raw = await runGit(root, ["show", "-s", "--format=%H%x00%s%x00%an%x00%aI%x00%B%x00%P", oid, "--"]);
    const [id, subject, author, date, message, parents] = raw.split("\0"); const parent = parents!.trim().split(" ")[0] || null;
    const names = await runGit(root, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", ...(parent ? [parent, oid] : [oid]), "--"]);
    const fields = names.split("\0"); const files = [];
    for (let i = 0; i < fields.length && fields[i];) {
      const status = fields[i++]!; const first = fields[i++]!;
      files.push(/[RC]/.test(status[0]!) ? { status, originalPath: first, path: fields[i++]! } : { status, path: first });
    }
    return { commit: { oid: id!, subject: subject!, author: author!, date: date!, message: message!.trimEnd() }, files, parent };
  }
  async content(path: string, file: string, mode: "staged" | "unstaged" | "untracked" | "commit", ref?: string): Promise<GitDiff> {
    if (mode === "unstaged" || mode === "untracked") return this.diff(path, file, "untracked");
    const root = await this.requireRoot(path);
    if (!file || isAbsolute(file) || relative(root, resolve(root, file)).startsWith("..")) throw new Error("无效仓库相对路径");
    const rev = mode === "commit" ? await this.revision(root, ref ?? "") : "";
    const raw = await runGit(root, ["show", `${rev}:${file}`]);
    const binary = raw.includes("\0");
    return { text: binary ? "二进制文件，无法显示文本内容" : raw.slice(0, 256 * 1024), binary, truncated: raw.length > 256 * 1024 };
  }
  async diff(path: string, file: string, mode: "staged" | "unstaged" | "untracked" | "commit", ref?: string): Promise<GitDiff> {
    const root = await this.requireRoot(path);
    if (!file || isAbsolute(file) || relative(root, resolve(root, file)).startsWith("..")) throw new Error("无效仓库相对路径");
    if (mode === "untracked") {
      const target = await realpath(resolve(root, file));
      if (relative(root, target).startsWith("..")) throw new Error("文件链接指向仓库外");
      const handle = await open(target, "r");
      try {
        if (!(await handle.stat()).isFile()) throw new Error("仅支持普通文件预览");
        const buffer = Buffer.alloc(256 * 1024 + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const binary = buffer.subarray(0, bytesRead).includes(0);
        return { text: binary ? "二进制文件，无法显示文本差异" : buffer.subarray(0, Math.min(bytesRead, 256 * 1024)).toString("utf8"), truncated: bytesRead > 256 * 1024, binary };
      } finally { await handle.close(); }
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short"];
    let originalPath: string | undefined;
    if (mode !== "commit") originalPath = (await this.status(root))?.changes.find(c => c.path === file)?.originalPath;
    if (mode === "staged") args.push("--cached");
    if (mode === "commit") {
      const detail = await this.commit(root, ref ?? "");
      originalPath = detail.files.find(f => f.path === file)?.originalPath;
      if (detail.parent) args.push(detail.parent, detail.commit.oid);
      else { args.splice(0, args.length, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", detail.commit.oid); }
    }
    const raw = await runGit(root, [...args, "-M", "--", `:(literal)${file}`, ...(originalPath ? [`:(literal)${originalPath}`] : [])]);
    return { text: raw.slice(0, 256 * 1024), truncated: raw.length > 256 * 1024, binary: raw.includes("Binary files ") };
  }
}
