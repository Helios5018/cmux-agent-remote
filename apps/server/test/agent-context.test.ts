import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SurfaceContextResponseSchema, ServerInfoResponseSchema, type CmuxPane } from "@car/protocol";
import { createHarness, type TestHarness } from "./helpers.ts";
import { FakeCmuxClient } from "../src/cmux/fake-client.ts";
import { CmuxCliClient } from "../src/cmux/cli-client.ts";
import { GitService, runGit } from "../src/services/git.ts";
import { limitContextText } from "../src/services/surface-context.ts";
import { StateStore } from "../src/state/store.ts";
import { StateEngine } from "../src/state/engine.ts";
import { createAgentGuideRoutes } from "../src/api/agent-guide.ts";

const dirs: string[] = [], harnesses: TestHarness[] = [];
afterEach(async () => { vi.restoreAllMocks(); harnesses.splice(0).forEach(h => h.store.close()); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(agent: "codex" | null = "codex") {
  const h = await createHarness(); harnesses.push(h);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "car-context-"))); dirs.push(dir);
  const id = randomUUID();
  const client = new FakeCmuxClient([{ id: randomUUID(), ref: "workspace:1", title: "Test", panes: [{ id: randomUUID(), ref: "pane:1", surfaces: [
    { id, ref: "surface:1", title: "Test", agent, content: "ready" },
    { id: randomUUID(), ref: "surface:2", title: "Other", agent: null, content: "other" },
  ] }] }], h.ctx.now, false);
  h.ctx.client = client; h.ctx.paneCwd = vi.fn(async (pane: CmuxPane) => { expect(pane.surfaces.map(s => s.id)).toEqual([id]); return dir; });
  h.ctx.engine = new StateEngine({ now: h.ctx.now, store: h.store });
  h.ctx.engine.syncTree(await client.getTree());
  const cookie = await h.loginCookie();
  return { h, dir, id, client, cookie, read: () => h.request(`/api/surfaces/${id}/context`, { cookie }) };
}

describe("Agent HTTP identity/context", () => {
  it("persists identity across concurrent opens/restarts, distinguishes new databases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "car-identity-")); dirs.push(dir);
    const a = await StateStore.open(join(dir, "a.db"));
    const b = await StateStore.open(join(dir, "a.db"));
    const other = await StateStore.open(join(dir, "b.db"));
    const id = a.instanceId;
    expect(b.instanceId).toBe(id); expect(other.instanceId).not.toBe(id);
    a.close(); b.close(); other.close();
    const reopened = await StateStore.open(join(dir, "a.db"));
    expect(reopened.instanceId).toBe(id); reopened.close();
  });
  it("requires login, publishes only identity fields with no-store", async () => {
    const { h, cookie, id } = await setup();
    expect((await h.request("/api/info")).status).toBe(401);
    expect((await h.request(`/api/surfaces/${id}/context`)).status).toBe(401);
    const response = await h.request("/api/info", { cookie });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(ServerInfoResponseSchema.strict().parse(body).instanceId).toBe(h.store.instanceId);
    expect(JSON.stringify(body)).not.toContain(h.ctx.config.pin);
  });
  it("reads Agent without changing viewed/state/tracker or sending input", async () => {
    const { h, id, client, read } = await setup();
    const before = structuredClone(h.ctx.engine.get(id));
    const snapshot = await client.readSurface(id);
    const tracked = vi.spyOn(client, "readSurface");
    const response = await read(); const body = SurfaceContextResponseSchema.parse(await response.json());
    expect(body.agent?.kind).toBe("codex"); expect(body.git).toBeNull(); expect(body.issues).toEqual([]);
    expect(body.output?.content).toBe("ready");
    expect(h.ctx.engine.get(id)).toEqual(before); expect(tracked).not.toHaveBeenCalled();
    expect(await client.readSurface(id)).toEqual(snapshot);
    expect(client.sentText).toEqual([]); expect(client.sentKeys).toEqual([]); expect(client.sentScrolls).toEqual([]);
  });
  it("covers shell, non-Git and local Git summary including unborn/dirty/detached", async () => {
    const { dir, read } = await setup(null);
    expect((await (await read()).json()).agent).toBeNull();
    await runGit(dir, ["init", "-b", "test"]);
    expect((await (await read()).json()).git).toEqual({ root: dir, branch: "test", hasChanges: false });
    await writeFile(join(dir, "README.md"), "test");
    expect((await (await read()).json()).git.hasChanges).toBe(true);
    await runGit(dir, ["add", "."]);
    await runGit(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test"]);
    await runGit(dir, ["checkout", "--detach"]);
    expect((await (await read()).json()).git).toEqual({ root: dir, branch: "HEAD", hasChanges: false });
  });
  it("preserves discovered kind with null status before engine observation", async () => {
    const { h, read } = await setup(); h.ctx.engine = new StateEngine();
    expect((await (await read()).json()).agent).toMatchObject({ kind: "codex", status: null, lastActivityAt: null });
  });
  it("does not attach stale Agent state to a newly discovered different kind", async () => {
    const { h, id, read } = await setup();
    const old = h.ctx.engine.get(id)!;
    vi.spyOn(h.ctx.engine, "get").mockReturnValue({ ...old, agent: "claude", sessionId: "old-session" });
    expect((await (await read()).json()).agent).toMatchObject({ kind: "codex", status: null, sessionId: null });
  });
  it("returns bounded sanitized partial failures and topology errors", async () => {
    const { h, client, read, cookie } = await setup();
    h.ctx.paneCwd = async () => { throw new Error("secret environment"); };
    vi.spyOn(client, "readSurfaceText").mockRejectedValue(new Error("secret environment"));
    const body = await (await read()).json();
    expect(body.cwd).toBeNull(); expect(body.output).toBeNull(); expect(body.issues).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("secret environment");
    expect((await h.request("/api/surfaces/not-uuid/context", { cookie })).status).toBe(400);
    expect((await h.request(`/api/surfaces/${randomUUID()}/context`, { cookie })).status).toBe(404);
    vi.spyOn(client, "getTree").mockRejectedValue(new Error("secret"));
    expect((await read()).status).toBe(503);
  });
  it("isolates Git failure and enforces UTF-8/line limits in HTTP response", async () => {
    const { client, read, id } = await setup();
    vi.spyOn(GitService.prototype, "summary").mockRejectedValue(new Error("credential"));
    vi.spyOn(client, "readSurfaceText").mockResolvedValue({ surfaceId: id, fetchedAt: 1, content: "old\n".repeat(250) + "界😀".repeat(20000) });
    const body = await (await read()).json();
    expect(body.issues).toEqual([{ section: "git", code: "GIT_UNAVAILABLE", message: "Git 摘要读取失败" }]);
    expect(Buffer.byteLength(body.output.content)).toBeLessThanOrEqual(65536);
    expect(body.output.content).not.toContain("�"); expect(body.output.content.endsWith("界😀")).toBe(true);
    expect(body.output.limited).toBe(true);
    const lines = limitContextText(Array.from({ length: 201 }, (_, n) => String(n)).join("\n"));
    expect(lines.content.split("\n")).toHaveLength(200); expect(lines.content.startsWith("1\n")).toBe(true);
  });
  it("CLI untracked 200-line reads leave the 400-line baseline unchanged", async () => {
    const id = randomUUID();
    const runner = vi.fn(async (args: string[]) => ({ code: 0, stderr: "", stdout: JSON.stringify({ surface_id: id, text: args.includes("200") ? "short" : "baseline" }) }));
    const client = new CmuxCliClient({ runner });
    const initial = await client.readSurface(id);
    expect((await client.readSurfaceText(id, { lines: 200 })).content).toBe("short");
    expect(client.snapshots.get(id)?.revision).toBe(initial.revision);
    expect((await client.readSurface(id)).revision).toBe(initial.revision);
    expect(runner.mock.calls[1]?.[0]).not.toContain("--scrollback");
  });
});

describe("Shell workspaces and guide", () => {
  it.each([null, undefined, "codex"])("creates launch=%s only in the returned surface with quoted cwd", async launch => {
    const { h, dir, client, cookie } = await setup();
    const cwd = join(dir, "space ' quote"); await mkdir(cwd);
    const response = await h.request("/api/workspaces", { cookie, method: "POST", body: JSON.stringify({ cwd, launch }) });
    expect(response.status).toBe(201); const body = await response.json();
    expect(client.sentText).toEqual([{ surfaceId: body.surfaceId, text: `cd -- '${cwd.replaceAll("'", "'\\''")}'${launch ? " && codex-d" : ""}` }]);
    expect(client.sentKeys).toEqual([{ surfaceId: body.surfaceId, key: "enter" }]);
  });
  it.each(["sendText", "sendKey"] as const)("preserves UUID and accurate failure at %s", async method => {
    const { h, dir, client, cookie } = await setup();
    vi.spyOn(client, method).mockRejectedValue(new Error("delivery unknown"));
    const response = await h.request("/api/workspaces", { cookie, method: "POST", body: JSON.stringify({ cwd: dir }) });
    expect(response.status).toBe(201); const body = await response.json();
    expect(body.surfaceId).toBeTruthy(); expect(body.workspaceId).toBeTruthy();
    expect(body.launchError).toContain(method === "sendKey" ? "仅补 Enter" : "写入结果未知");
    expect((await client.getTree()).workspaces.some(w => w.id === body.workspaceId)).toBe(true);
  });
  it("rejects invalid cwd/launch before creation", async () => {
    const { h, dir, client, cookie } = await setup(); const create = vi.spyOn(client, "createWorkspace");
    for (const body of [{ cwd: "relative" }, { cwd: `${dir}/missing` }, { cwd: dir + "\n" }, { cwd: dir, launch: "arbitrary" }]) {
      expect((await h.request("/api/workspaces", { cookie, method: "POST", body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("guide is anonymous Markdown; missing/empty source is explicit failure", async () => {
    const { h, dir } = await setup();
    const response = await h.request("/agent-guide.md");
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache"); expect(await response.text()).toContain("/api/info");
    const source = new URL(`file://${dir}/missing.md`);
    expect((await createAgentGuideRoutes(source).request("/agent-guide.md")).status).toBe(503);
    await writeFile(source, "");
    expect((await createAgentGuideRoutes(source).request("/agent-guide.md")).status).toBe(503);
  });
  it("one login Cookie supports prepare/delete; a new session cannot consume its token", async () => {
    const { h, dir, cookie } = await setup(); const path = join(dir, "temporary.txt"); await writeFile(path, "only test");
    const operation = (body: unknown, owner = cookie) => h.request("/api/files/operation", { cookie: owner, method: "POST", body: JSON.stringify(body) });
    const prepared = await (await operation({ action: "delete_prepare", paths: [path] })).json();
    const second = await h.loginCookie();
    expect((await operation({ action: "delete", token: prepared.token, confirm: true }, second)).status).not.toBe(200);
    const result = await operation({ action: "delete", token: prepared.token, confirm: true });
    expect(result.status).toBe(200); expect((await result.json()).paths).toEqual([path]);
  });
});
