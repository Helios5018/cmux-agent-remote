import { CreateWorkspaceDialog } from "../features/workspace/CreateWorkspaceDialog.tsx";
import { useEffect, useMemo, useState } from "react";
import type { AttentionGroup, CmuxSurface } from "@car/protocol";
import { attentionGroupOf } from "@car/protocol";
import { APP_NAME_MAX_LENGTH, DEFAULT_HOME_TITLE } from "../appName.ts";
import { TopBar } from "../components/TopBar.tsx";
import { useAppName } from "../hooks/useAppName.tsx";
import { useAppStore } from "../stores/AppStore.tsx";
import { agentsBySurface } from "../stores/selectors.ts";
import type { Route } from "../hooks/useRouter.ts";
import { WorkspaceCloseDialog, type WorkspaceCloseTarget } from "../features/workspace/WorkspaceCloseDialog.tsx";
import { TreeView } from "../features/workspace/TreeView.tsx";
import type { VisibleWorkspace, VisiblePane } from "../features/workspace/model.ts";
import { isUsageSentinel } from "../features/workspace/usage-sentinel.ts";

/**
 * 首页。
 *
 * 只有一个视图：直接按 cmux 的 Workspace → Pane → Surface 渲染，
 * cmux-sentinel 的用量表（hidden sentinel）不参与渲染，与 cmux 自带侧栏一致。
 * 需要你处理的 Agent 数量走顶栏汇总和 workspace 标题上的角标，不再单独占一屏。
 * 展开折叠状态与筛选条件存在 localStorage，刷新和重连都不会丢。
 */

const TREE_REFRESH_MS = 4000;
const PREFS_KEY = "car.home.prefs.v1";

interface Prefs {
  /** 只显示跑着 Agent 的 surface。 */
  agentsOnly: boolean;
  /** 折叠起来的 workspace / pane key。 */
  collapsed: string[];
}

const DEFAULT_PREFS: Prefs = { agentsOnly: true, collapsed: [] };

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      agentsOnly: parsed.agentsOnly !== false,
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function HomePage({
  navigate,
  back,
  workspaceId,
}: {
  navigate: (route: Route) => void;
  back?: () => void;
  /** 只看某一个 workspace（来自 #/w/:id 深链）。 */
  workspaceId?: string;
}) {
  const { inbox, tree, error, refreshInbox, refreshTree, subscribe, connection, renameWorkspace, createPane } =
    useAppStore();
  const { homeTitle, setAppName } = useAppName();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [closeTarget, setCloseTarget] = useState<WorkspaceCloseTarget | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    subscribe(null);
  }, [subscribe]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 拓扑没有走 WebSocket 推送，这里自己轮询；页面切到后台就停，省电。
  useEffect(() => {
    void refreshTree();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshTree();
    }, TREE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshTree]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // 隐私模式下写不了 localStorage，不影响使用。
    }
  }, [prefs]);

  const agents = useMemo(() => agentsBySurface(inbox), [inbox]);
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const keyword = query.trim().toLowerCase();

  const model = useMemo<VisibleWorkspace[]>(() => {
    if (!tree) return [];
    const result: VisibleWorkspace[] = [];

    for (const workspace of tree.workspaces) {
      // 用量表在 cmux 那边就不占 workspace 列表，这里保持一致，「全部 surface」也不放出来。
      if (isUsageSentinel(workspace)) continue;
      if (workspaceId && workspace.id !== workspaceId) continue;
      const workspaceHit =
        keyword.length === 0 ||
        workspace.title.toLowerCase().includes(keyword) ||
        workspace.ref.includes(keyword);

      const counts: Record<AttentionGroup, number> = { NEEDS_YOU: 0, WORKING: 0, IDLE: 0 };
      const panes: VisiblePane[] = [];
      let hidden = 0;

      for (const pane of workspace.panes) {
        const surfaces: CmuxSurface[] = [];
        for (const surface of pane.surfaces) {
          const agent = agents.get(surface.id);
          if (agent) counts[attentionGroupOf(agent.status)] += 1;

          if (prefs.agentsOnly && surface.agent === null && !agent) {
            hidden += 1;
            continue;
          }
          const surfaceHit =
            workspaceHit ||
            surface.title.toLowerCase().includes(keyword) ||
            surface.ref.includes(keyword);
          if (!surfaceHit) continue;
          surfaces.push(surface);
        }
        if (surfaces.length > 0) panes.push({ pane, key: pane.id ?? pane.ref, surfaces });
      }

      if (panes.length === 0) continue;
      result.push({ workspace, panes, counts, hidden });
    }
    return result;
  }, [tree, agents, prefs.agentsOnly, keyword, workspaceId]);

  const allKeys = useMemo(
    () => model.flatMap((item) => [item.workspace.id, ...item.panes.map((pane) => pane.key)]),
    [model],
  );
  // 只看 workspace 层：折在里面的 pane 不该影响「一键折叠 / 展开」的语义。
  const anyExpanded = model.some((item) => !collapsed.has(item.workspace.id));

  const toggle = (key: string) =>
    setPrefs((current) => {
      const next = new Set(current.collapsed);
      if (next.has(key)) {
        next.delete(key);
        // 展开 workspace 时直达 surface；pane 自己的折叠按钮仍独立生效。
        const workspace = tree?.workspaces.find(item => item.id === key);
        for (const pane of workspace?.panes ?? []) next.delete(pane.id ?? pane.ref);
      } else next.add(key);
      return { ...current, collapsed: [...next] };
    });

  const toggleAll = () =>
    setPrefs((current) => ({ ...current, collapsed: anyExpanded ? allKeys : [] }));

  const summary = inbox?.summary;
  const summaryText = summary
    ? [
        summary.needsYou > 0 ? `${summary.needsYou} 需要你` : null,
        summary.working > 0 ? `${summary.working} 运行中` : null,
        summary.error > 0 ? `${summary.error} 出错` : null,
        summary.idle > 0 ? `${summary.idle} 空闲` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "加载中…";

  const focusedWorkspace = workspaceId ? tree?.workspaces.find(w => w.id === workspaceId || w.ref === workspaceId) : undefined;
  const revealCreated = async (create: () => Promise<string>) => {
    const id = await create();
    setQuery("");
    setPrefs(current => ({ ...current, agentsOnly: false,
      collapsed: current.collapsed.filter(key => key !== id) }));
  };
  const title = focusedWorkspace ? focusedWorkspace.title : homeTitle;
  // 搜索时强制展开，否则搜到的东西还藏在折叠里就没意义了。
  const forceExpand = keyword.length > 0;

  return (
    <div className="page">
      {closeTarget ? <WorkspaceCloseDialog target={closeTarget} onDismiss={() => setCloseTarget(null)}
        onWorkspaceClosed={id => { if (workspaceId === id) navigate({ name: "inbox" }); }} /> : null}
      {creatingWorkspace && <CreateWorkspaceDialog onDismiss={() => setCreatingWorkspace(false)}
        onCreated={id => { void revealCreated(async () => id); }} navigate={navigate} />}
      <TopBar
        closeActions={focusedWorkspace ? {
          workspace: () => setCloseTarget({ workspace: focusedWorkspace, mode: "workspace" }),
          pane: () => setCloseTarget({ workspace: focusedWorkspace, mode: "pane" }),
        } : undefined}
        onCreate={async () => { if (focusedWorkspace) await revealCreated(() => createPane(focusedWorkspace.id)); else setCreatingWorkspace(true); }}
        createLabel={focusedWorkspace ? "增加 pane" : "增加 workspace"}
        title={title}
        subtitle={summaryText}
        onBack={back}
        onRename={
          focusedWorkspace
            ? (name) => {
                const next = name.trim();
                if (!next) return;
                void renameWorkspace(focusedWorkspace.id, next);
              }
            : setAppName
        }
        renameMaxLength={focusedWorkspace ? 80 : APP_NAME_MAX_LENGTH}
        renamePlaceholder={focusedWorkspace ? focusedWorkspace.title : DEFAULT_HOME_TITLE}
        renameAriaLabel={focusedWorkspace ? "Workspace 名称" : "应用名称"}
      />

      <div className="tree-toolbar">
        <div className="tree-search-wrap">
          <input
            className="tree-search"
            value={query}
            placeholder="搜索 workspace / surface"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="tree-search-clear" onClick={() => setQuery("")} aria-label="清空">
              ✕
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className={`chip-button ${prefs.agentsOnly ? "on" : ""}`}
          onClick={() => setPrefs((current) => ({ ...current, agentsOnly: !current.agentsOnly }))}
          title={prefs.agentsOnly ? "点击显示全部 surface" : "点击只看跑着 Agent 的 surface"}
        >
          {prefs.agentsOnly ? "只看 Agent" : "全部 surface"}
        </button>
        <button type="button" className="chip-button" onClick={toggleAll}>
          {anyExpanded ? "全部折叠" : "全部展开"}
        </button>
        <button
          type="button"
          className="chip-button"
          onClick={() => {
            void refreshInbox();
            void refreshTree();
          }}
        >
          手动刷新
        </button>
      </div>

      <div className="scroll-area">
        {connection !== "open" ? (
          <div className="banner">连接中断，正在自动重连…（已退化为轮询）</div>
        ) : null}
        {/* 首页也会发写请求（新建 surface），失败必须看得见，否则就是「点了没反应」 */}
        {error ? <div className="banner error">{error}</div> : null}

        <TreeView
          model={model}
          agents={agents}
          now={now}
          collapsed={collapsed}
          forceExpand={forceExpand}
          loading={!tree}
          keyword={keyword}
          onToggle={toggle}
          onClose={(workspace, mode) => setCloseTarget({ workspace, mode })}
          onCreatePane={(id) => revealCreated(() => createPane(id))}
          onRenameWorkspace={(id, name) => {
            const next = name.trim();
            if (!next) return;
            void renameWorkspace(id, next);
          }}
          navigate={navigate}
        />

        {workspaceId ? (
          <div className="footer-actions">
            <button type="button" className="ghost-button" onClick={() => navigate({ name: "inbox" })}>
              查看全部 workspace
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
