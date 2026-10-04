export type GitMark = "ignored" | "untracked" | "unstaged" | "staged" | "added" | "deleted" | "updated";
export interface GitChange { path: string; originalPath?: string; index: string; worktree: string; conflict: boolean; mark: GitMark }
export interface GitFetchState { remote: string | null; running: boolean; attemptedAt?: number; succeededAt?: number; error?: string }
export interface GitStatus { root: string; branch: string; oid: string | null; upstream: string | null; ahead: number; behind: number; operation: string | null; changes: GitChange[]; ignored: string[]; fetch: GitFetchState }
export interface GitBranch { ref: string; name: string; remote: boolean; current: boolean; upstream: string; tracking: string; oid: string; subject: string; date: string }
export interface GitCommit { oid: string; subject: string; author: string; date: string; message?: string }
export interface GitHistory { commits: GitCommit[]; next: number | null }
export interface GitDiff { text: string; truncated: boolean; binary: boolean }
export interface GitCommitDetail { commit: GitCommit; files: { path: string; originalPath?: string; status: string }[]; parent: string | null }
