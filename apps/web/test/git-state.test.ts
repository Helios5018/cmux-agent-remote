import { describe, expect, it } from "vitest";
import { pathMark, inGroup } from "../src/features/files/git-state.ts";
import type { GitStatus, GitChange } from "@car/protocol";
const change = (path: string, index: string, worktree: string, mark: GitChange["mark"], conflict = false): GitChange => ({ path, index, worktree, mark, conflict });
const repo = (changes: GitChange[], ignored: string[] = []): GitStatus => ({ root: "/repo", branch: "main", oid: null, upstream: null, ahead: 0, behind: 0, operation: null, fetch: { remote: null, running: false }, changes, ignored });
describe("Yazi Git status mapping", () => {
  it("uses Yazi priority for directories and propagates ignored directories down only", () => {
    const state = repo([change("src/a", "M", " ", "staged"), change("src/b", " ", "M", "unstaged"), change("src/c", "?", "?", "untracked")], ["cache/", "src/ignored"]);
    expect(pathMark(state, "/repo/src")).toBe("untracked"); expect(pathMark(state, "/repo/src/a")).toBe("staged");
    expect(pathMark(state, "/repo/cache/deep/a")).toBe("ignored"); expect(pathMark(state, "/repo/cache2")).toBeNull(); expect(pathMark(state, "/another/src")).toBeNull();
  });
  it("shows partially staged files in both groups and conflicts only in conflict group", () => {
    const both = change("a", "M", "M", "unstaged"); expect(inGroup(both, "staged")).toBe(true); expect(inGroup(both, "unstaged")).toBe(true);
    const conflict = change("a", "U", "U", "updated", true); expect(inGroup(conflict, "conflict")).toBe(true); expect(inGroup(conflict, "staged")).toBe(false);
  });
});
