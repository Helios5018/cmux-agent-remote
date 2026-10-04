import type { AgentKind, CmuxPane, CmuxSurface, CmuxTree, CmuxWorkspace } from "@car/protocol";

/**
 * Agent Process Discovery。
 *
 * 输入是 `cmux tree --all --json --id-format both` 与
 * `cmux top --all --processes --json` 两份原始 JSON，
 * 输出是带 Agent 归属的标准化拓扑。
 */

type Json = Record<string, unknown>;

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((x) => typeof x === "object" && x !== null) as Json[]) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** cmux 自己识别出来的 coding agent id → 我们支持的三种。 */
const CODING_AGENT_ID_MAP: Record<string, AgentKind> = {
  claude: "claude",
  claude_code: "claude",
  "claude-code": "claude",
  codex: "codex",
  grok: "grok",
  pi: "pi",
};

/** 兜底：按进程名 / 路径识别。 */
const PROCESS_PATTERNS: Array<{ kind: AgentKind; re: RegExp }> = [
  { kind: "claude", re: /(^|\/)claude(-code)?$/i },
  { kind: "codex", re: /(^|\/)codex(-[\w.]+)?$/i },
  { kind: "grok", re: /(^|\/)grok(-[\w.]+)?$/i },
  { kind: "pi", re: /(^|\/)pi$/i },
];

function matchProcessName(name: string | undefined, path: string | undefined): AgentKind | null {
  for (const candidate of [name, path]) {
    if (!candidate) continue;
    for (const { kind, re } of PROCESS_PATTERNS) {
      if (re.test(candidate)) return kind;
    }
  }
  return null;
}

export interface ProcessNode {
  pid: number;
  ppid?: number;
  name?: string;
  path?: string;
  surfaceId?: string;
  workspaceId?: string;
  children: ProcessNode[];
}

export interface SurfaceProcessInfo {
  surfaceRef: string;
  surfaceId?: string;
  processes: ProcessNode[];
}

function parseProcessNode(raw: Json): ProcessNode {
  return {
    pid: num(raw["pid"]) ?? 0,
    ppid: num(raw["ppid"]),
    name: str(raw["name"]),
    path: str(raw["path"]),
    surfaceId: str(raw["cmux_surface_id"]),
    workspaceId: str(raw["cmux_workspace_id"]),
    children: asArray(raw["children"]).map(parseProcessNode),
  };
}

function* walk(nodes: ProcessNode[]): Generator<ProcessNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

export interface AgentProcessMap {
  /** pid → agent 类型，来自 cmux 自己的 coding_agents 分类。 */
  pidToAgent: Map<number, AgentKind>;
  /** surface ref → 该 surface 下的进程树。 */
  bySurfaceRef: Map<string, SurfaceProcessInfo>;
  /** surface UUID → 该 surface 下的进程树。 */
  bySurfaceId: Map<string, SurfaceProcessInfo>;
}

/** 解析 `cmux top --all --processes --json`。 */
export function parseTopJson(raw: unknown): AgentProcessMap {
  const root = (raw ?? {}) as Json;
  const pidToAgent = new Map<number, AgentKind>();

  for (const entry of asArray(root["coding_agents"])) {
    const id = str(entry["id"])?.toLowerCase();
    const kind = id ? CODING_AGENT_ID_MAP[id] : undefined;
    if (!kind) continue;
    const resources = (entry["resources"] ?? {}) as Json;
    for (const pid of Array.isArray(resources["pids"]) ? resources["pids"] : []) {
      const value = num(pid);
      if (value !== undefined) pidToAgent.set(value, kind);
    }
  }

  const bySurfaceRef = new Map<string, SurfaceProcessInfo>();
  const bySurfaceId = new Map<string, SurfaceProcessInfo>();

  for (const window of asArray(root["windows"])) {
    for (const workspace of asArray(window["workspaces"])) {
      for (const pane of asArray(workspace["panes"])) {
        for (const surface of asArray(pane["surfaces"])) {
          const ref = str(surface["ref"]);
          if (!ref) continue;
          const processes = asArray(surface["processes"]).map(parseProcessNode);
          const surfaceId =
            str(surface["id"]) ??
            [...walk(processes)].find((p) => p.surfaceId)?.surfaceId;
          const info: SurfaceProcessInfo = { surfaceRef: ref, surfaceId, processes };
          bySurfaceRef.set(ref, info);
          if (surfaceId) bySurfaceId.set(surfaceId, info);
        }
      }
    }
  }

  return { pidToAgent, bySurfaceRef, bySurfaceId };
}

export interface DetectedAgent {
  kind: AgentKind;
  pid: number;
}

/** 在一个 surface 的进程树里找出正在跑的 Agent。 */
export function detectAgentInSurface(
  info: SurfaceProcessInfo | undefined,
  pidToAgent: Map<number, AgentKind>,
): DetectedAgent | null {
  if (!info) return null;
  // 优先取层级最浅的匹配进程（即 agent CLI 本体，而不是它 fork 出来的 node）。
  const queue: Array<{ node: ProcessNode; depth: number }> = info.processes.map((node) => ({ node, depth: 0 }));
  let best: { kind: AgentKind; pid: number; depth: number } | null = null;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { node, depth } = item;
    const kind = pidToAgent.get(node.pid) ?? matchProcessName(node.name, node.path);
    if (kind && (best === null || depth < best.depth)) {
      best = { kind, pid: node.pid, depth };
    }
    for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
  }

  return best ? { kind: best.kind, pid: best.pid } : null;
}

/** 解析 `cmux tree --all --json --id-format both` + top 的进程信息。 */
export function parseTree(rawTree: unknown, processMap: AgentProcessMap, now: number): CmuxTree {
  const root = (rawTree ?? {}) as Json;
  const workspaces: CmuxWorkspace[] = [];
  const pidIndex: Record<string, string> = {};

  for (const window of asArray(root["windows"])) {
    const windowRef = str(window["ref"]);
    for (const workspace of asArray(window["workspaces"])) {
      const workspaceId = str(workspace["id"]);
      const workspaceRef = str(workspace["ref"]);
      if (!workspaceId || !workspaceRef) continue;

      const panes: CmuxPane[] = [];
      for (const pane of asArray(workspace["panes"])) {
        const paneRef = str(pane["ref"]);
        if (!paneRef) continue;
        const surfaces: CmuxSurface[] = [];

        for (const surface of asArray(pane["surfaces"])) {
          const ref = str(surface["ref"]);
          if (!ref) continue;
          const info = processMap.bySurfaceRef.get(ref);
          const id = str(surface["id"]) ?? info?.surfaceId ?? ref;
          const detected = detectAgentInSurface(info, processMap.pidToAgent);

          // Hook 只能拿到自己的 pid，这里建立 pid → surface 的反查表。
          if (info) {
            for (const node of walk(info.processes)) {
              if (node.pid > 0) pidIndex[String(node.pid)] = id;
            }
          }

          surfaces.push({
            id,
            ref,
            paneId: str(pane["id"]),
            paneRef,
            workspaceId,
            workspaceRef,
            title: str(surface["title"]) ?? ref,
            type: str(surface["type"]) ?? "terminal",
            tty: str(surface["tty"]) ?? null,
            focused: bool(surface["focused"]),
            selected: bool(surface["selected"]) || bool(surface["selected_in_pane"]),
            index: num(surface["index"]) ?? 0,
            agent: detected?.kind ?? null,
            agentPid: detected?.pid ?? null,
          });
        }

        panes.push({
          id: str(pane["id"]),
          ref: paneRef,
          index: num(pane["index"]) ?? 0,
          focused: bool(pane["focused"]),
          surfaces,
        });
      }

      workspaces.push({
        id: workspaceId,
        ref: workspaceRef,
        index: num(workspace["index"]) ?? 0,
        title: str(workspace["custom_title"]) ?? str(workspace["title"]) ?? workspaceRef,
        description: str(workspace["description"]) ?? null,
        selected: bool(workspace["selected"]) || bool(workspace["active"]),
        windowRef,
        panes,
      });
    }
  }

  return { workspaces, pidIndex, fetchedAt: now };
}

/** 拍平出所有 surface，方便按 id 查找。 */
export function flattenSurfaces(tree: CmuxTree): CmuxSurface[] {
  return tree.workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.surfaces));
}

/** 只保留跑着 Agent 的 surface。 */
export function agentSurfaces(tree: CmuxTree): CmuxSurface[] {
  return flattenSurfaces(tree).filter((surface) => surface.agent !== null);
}
