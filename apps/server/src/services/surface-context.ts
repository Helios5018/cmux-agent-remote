import { tidyTerminalText } from "@car/shared";
import type { SurfaceContextResponse } from "@car/protocol";
import type { AppContext } from "../context.ts";
import { resolvePaneCwd } from "../cmux/cwd.ts";
import { FileService } from "./files.ts";
import { GitService } from "./git.ts";

export class ContextTopologyError extends Error {}

/** Keep the latest complete UTF-8 characters, independently bounded by lines and bytes. */
export function limitContextText(text: string) {
  const reachedReadLimit = text.split("\n").length >= 200;
  const lines = tidyTerminalText(text).split("\n");
  const bytes = Buffer.from(lines.slice(-200).join("\n"), "utf8");
  let start = Math.max(0, bytes.length - 64 * 1024);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { content: bytes.subarray(start).toString("utf8"), limitLines: 200 as const,
    limited: reachedReadLimit || start > 0 };
}

export async function readSurfaceContext(ctx: AppContext, surfaceId: string): Promise<SurfaceContextResponse | null> {
  const tree = await ctx.client.getTree().catch(() => { throw new ContextTopologyError(); });
  for (const workspace of tree.workspaces) for (const pane of workspace.panes) {
    const surface = pane.surfaces.find(s => s.id === surfaceId);
    if (!surface) continue;
    // Do not syncTree or markViewed: observing this endpoint must not change state.
    const observed = ctx.engine.get(surfaceId);
    const kind = surface.agent ?? (observed?.status !== "CLOSED" ? observed?.agent : null);
    // A recycled/relaunched surface can be discovered before the engine catches up.
    const state = observed && observed.agent === kind && observed.status !== "CLOSED" ? observed : undefined;
    const result: SurfaceContextResponse = {
      instanceId: ctx.store.instanceId,
      surface: { id: surface.id, title: surface.title, type: surface.type, paneId: pane.id ?? null,
        workspaceId: workspace.id, workspaceTitle: workspace.title },
      agent: kind ? { kind, sessionId: state?.sessionId ?? null, status: state?.status ?? null,
        currentActivity: state?.currentActivity ?? null, hookConnected: state?.hookConnected ?? false,
        lastActivityAt: state?.lastActivityAt ?? null } : null,
      cwd: null, git: null, output: null, issues: [], fetchedAt: 0,
    };
    const issue = (section: "cwd" | "git" | "output", code: string, message: string) => result.issues.push({ section, code, message });
    await Promise.all([
      (async () => {
        try {
          const cwd = await (ctx.paneCwd ?? resolvePaneCwd)({ ...pane, surfaces: [surface] });
          if (cwd) result.cwd = await new FileService().directory(cwd);
          if (!result.cwd) issue("cwd", "CWD_UNAVAILABLE", "无法确定目标会话的工作目录");
        } catch { issue("cwd", "CWD_UNAVAILABLE", "无法确定目标会话的工作目录"); }
        if (result.cwd) {
          try { result.git = await new GitService().summary(result.cwd); }
          catch { issue("git", "GIT_UNAVAILABLE", "Git 摘要读取失败"); }
        }
      })(),
      (async () => {
        try {
          const output = await ctx.client.readSurfaceText(surfaceId, { lines: 200, scrollback: false });
          result.output = { ...limitContextText(output.content), fetchedAt: output.fetchedAt };
        } catch { issue("output", "OUTPUT_UNAVAILABLE", "终端输出读取失败；目标可能已关闭"); }
      })(),
    ]);
    result.issues.sort((a, b) => a.section.localeCompare(b.section));
    result.fetchedAt = ctx.now();
    return result;
  }
  return null;
}
