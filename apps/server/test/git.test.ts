import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, runGit } from "../src/services/git.ts";
import { createHarness } from "./helpers.ts";
import { createApp } from "../src/app.ts";
let temp: string; let root: string; let git: GitService;
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "car-git-"))); root = join(temp, "repo"); await mkdir(root); git = new GitService();
  await runGit(root, ["init", "-b", "main"]); await runGit(root, ["config", "core.hooksPath", "/dev/null"]); await runGit(root, ["config", "user.name", "Test"]); await runGit(root, ["config", "user.email", "test@example.test"]);
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
async function commit(message = "initial") { await runGit(root, ["add", "."]); await runGit(root, ["commit", "-m", message]); }
describe("Git read-only browser", () => {
  it("handles outside repositories, unborn HEAD, ignored files and weird names", async () => {
    expect(await git.status(temp)).toBeNull(); expect(await git.history(root)).toEqual({ commits: [], next: null });
    expect(await git.status(root)).toMatchObject({ branch: "main", oid: null, changes: [] });
    await writeFile(join(root, ".gitignore"), "cache/\n"); await mkdir(join(root, "cache")); await writeFile(join(root, "cache/a"), "ignored");
    await writeFile(join(root, "中文\nfile.txt"), "new");
    const state = (await git.status(root))!;
    expect(state.ignored).toContain("cache/"); expect(state.changes.some(c => c.path === "中文\nfile.txt" && c.mark === "untracked")).toBe(true);
  });
  it("separates staged/unstaged changes and handles deleted and renamed files", async () => {
    await writeFile(join(root, "both"), "original\n"); await writeFile(join(root, "deleted"), "gone\n"); await writeFile(join(root, "old"), "rename\n"); await commit();
    await writeFile(join(root, "both"), "staged\n"); await runGit(root, ["add", "both"]); await writeFile(join(root, "both"), "unstaged\n"); await rm(join(root, "deleted")); await runGit(root, ["mv", "old", "new"]);
    const state = (await git.status(root))!;
    expect(state.changes.find(c => c.path === "both")).toMatchObject({ index: "M", worktree: "M" });
    expect(state.changes.find(c => c.path === "deleted")).toMatchObject({ mark: "deleted" });
    expect(state.changes.find(c => c.path === "new")).toMatchObject({ originalPath: "old" });
    expect((await git.diff(root, "both", "staged")).text).toContain("+staged");
    expect((await git.diff(root, "both", "unstaged")).text).toContain("+unstaged");
    expect((await git.diff(root, "deleted", "unstaged")).text).toContain("-gone");
    expect((await git.diff(root, "new", "staged")).text).toContain("rename from old");
    expect((await git.content(root, "both", "staged")).text).toBe("staged\n");
    expect((await git.content(root, "both", "unstaged")).text).toBe("unstaged\n");
  });
  it("reads branches and first/normal commit details without checkout", async () => {
    await writeFile(join(root, "a"), "first\n"); await commit("first\n\nFull message");
    const first = (await git.history(root)).commits[0]!;
    const detail = await git.commit(root, first.oid); expect(detail.parent).toBeNull(); expect(detail.commit.message).toContain("Full message"); expect(detail.files[0]!.path).toBe("a");
    expect((await git.diff(root, "a", "commit", first.oid)).text).toContain("+first");
    expect((await git.content(root, "a", "commit", first.oid)).text).toBe("first\n");
    await runGit(root, ["branch", "feature"]); await writeFile(join(root, "a"), "second\n"); await commit("second");
    const branches = await git.branches(root); expect(branches.find(b => b.name === "main")!.current).toBe(true);
    expect((await git.history(root, "refs/heads/feature")).commits).toHaveLength(1);
    expect((await git.history(root)).commits).toHaveLength(2); expect((await git.status(root))!.branch).toBe("main");
    await expect(git.history(root, "--all")).rejects.toThrow("无效");
  });
  it("fetches once per cooldown, updates remote refs, preserves files and falls back on failure", async () => {
    await writeFile(join(root, "a"), "initial\n"); await commit();
    const remote = join(temp, "remote.git"); await runGit(temp, ["init", "--bare", remote]); await runGit(root, ["remote", "add", "origin", remote]); await runGit(root, ["push", "-u", "origin", "main"]);
    const clone = join(temp, "clone"); await runGit(temp, ["clone", "-b", "main", remote, clone]); await runGit(clone, ["config", "core.hooksPath", "/dev/null"]); await runGit(clone, ["config", "user.name", "Test"]); await runGit(clone, ["config", "user.email", "test@example.test"]);
    await writeFile(join(clone, "remote-file"), "remote\n"); await runGit(clone, ["add", "."]); await runGit(clone, ["commit", "-m", "remote commit"]); await runGit(clone, ["push"]);
    await writeFile(join(root, "a"), "local work\n");
    const [one, two] = await Promise.all([git.fetch(root), git.fetch(root)]); expect(one.succeededAt).toBeTruthy(); expect(two.attemptedAt).toBe(one.attemptedAt);
    expect((await git.status(root))!.behind).toBe(1); expect(await readFile(join(root, "a"), "utf8")).toBe("local work\n");
    expect((await git.fetch(root)).attemptedAt).toBe(one.attemptedAt);
    await runGit(root, ["remote", "set-url", "origin", join(temp, "missing")]); const failed = await git.fetch(root, true);
    expect(failed.error).toBeTruthy(); expect(failed.succeededAt).toBe(one.succeededAt); expect((await git.status(root))!.behind).toBe(1);
  });
  it("supports worktrees and conflict state", async () => {
    await writeFile(join(root, "a"), "base\n"); await commit();
    const wt = join(temp, "worktree"); await runGit(root, ["worktree", "add", "-b", "other", wt]);
    expect((await git.status(wt))!.branch).toBe("other"); await writeFile(join(wt, "a"), "other\n"); await runGit(wt, ["commit", "-am", "other"]);
    await writeFile(join(root, "a"), "main\n"); await commit("main"); await expect(runGit(root, ["merge", "other"])).rejects.toThrow();
    expect(await git.status(root)).toMatchObject({ operation: "merge", changes: [expect.objectContaining({ conflict: true, path: "a" })] });
    expect((await git.diff(root, "a", "unstaged")).text).toContain("<<<<<<<");
  });
  it("bounds untracked content, labels binary and rejects traversal/symlink escape", async () => {
    await writeFile(join(root, "big"), "x".repeat(300000)); expect((await git.diff(root, "big", "untracked")).truncated).toBe(true);
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2])); expect((await git.diff(root, "binary", "untracked")).binary).toBe(true);
    await writeFile(join(temp, "outside"), "private"); await symlink(join(temp, "outside"), join(root, "link"));
    await expect(git.diff(root, "../outside", "untracked")).rejects.toThrow(); await expect(git.diff(root, "link", "untracked")).rejects.toThrow();
  });
  it("reads detached HEAD, paginates history and treats special pathspecs literally", async () => {
    await writeFile(join(root, "[a].txt"), "one\n"); await writeFile(join(root, "a.txt"), "other\n"); await commit();
    await writeFile(join(root, "[a].txt"), "two\n"); await writeFile(join(root, "a.txt"), "unrelated\n");
    const diff = (await git.diff(root, "[a].txt", "unstaged")).text; expect(diff).toContain("+two"); expect(diff).not.toContain("unrelated");
    const tree = (await runGit(root, ["rev-parse", "HEAD^{tree}"])).trim(); let parent = (await git.status(root))!.oid!;
    for (let i = 0; i < 51; i++) parent = (await runGit(root, ["commit-tree", tree, "-p", parent, "-m", `commit ${i}`])).trim();
    await runGit(root, ["update-ref", "refs/heads/main", parent]);
    expect((await git.history(root)).next).toBe(50); expect((await git.history(root, "HEAD", 50)).commits).toHaveLength(2);
    await runGit(root, ["checkout", "--detach"]); expect((await git.status(root))!.branch).toContain("detached");
  });
  it("reports missing remotes and bounds slow Git commands", async () => {
    expect((await git.fetch(root)).error).toBe("未配置远程仓库");
    await expect(runGit(root, ["-c", "alias.slow=!sleep 1", "slow"], 20)).rejects.toThrow("超时");
  });
  it("requires authentication and rejects cross-site fetch and malformed requests", async () => {
    const h = await createHarness(); const app = createApp(h.ctx);
    try {
      expect((await app.request(`/api/git/status?path=${encodeURIComponent(root)}`)).status).toBe(401);
      const cookie = await h.loginCookie();
      expect((await app.request(`/api/git/status?path=${encodeURIComponent(root)}`, { headers: { cookie } })).status).toBe(200);
      expect((await app.request("/api/git/fetch", { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ path: root }) })).status).toBe(403);
      expect((await app.request(`/api/git/history?path=${encodeURIComponent(root)}&offset=-1`, { headers: { cookie } })).status).toBe(400);
    } finally { h.store.close(); }
  });
});
