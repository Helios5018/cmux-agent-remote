import type { AgentState, CmuxWorkspace } from "@car/protocol";
import { RenameMenu } from "../../components/RenameMenu.tsx";
import type { Route } from "../../hooks/useRouter.ts";
import type { VisibleWorkspace } from "./model.ts";
import { NewSurfaceRow } from "./NewSurfaceRow.tsx";
import { SurfaceRow } from "./SurfaceRow.tsx";

export function TreeView({
  model,
  agents,
  now,
  collapsed,
  forceExpand,
  loading,
  keyword,
  onToggle,
  onRenameWorkspace,
  onCreatePane,
  onClose,
  navigate,
}: {
  model: VisibleWorkspace[];
  agents: Map<string, AgentState>;
  now: number;
  collapsed: Set<string>;
  forceExpand: boolean;
  loading: boolean;
  keyword: string;
  onToggle: (key: string) => void;
  onClose: (workspace: CmuxWorkspace, mode: "workspace" | "pane") => void;
  onCreatePane?: (workspaceId: string) => Promise<unknown>;
  onRenameWorkspace?: (workspaceId: string, name: string) => void;
  navigate: (route: Route) => void;
}) {
  if (loading) return <div className="empty">加载 cmux 结构中…</div>;

  if (model.length === 0) {
    return (
      <div className="empty">
        <p>{keyword ? "没有匹配的 workspace / surface。" : "没有可显示的 surface。"}</p>
        <p className="empty-hint">
          {keyword ? "换个关键词试试。" : "如果只是没在跑 Agent，可以点上面的「只看 Agent」切换成全部 surface。"}
        </p>
      </div>
    );
  }

  return (
    <>
      {model.map(({ workspace, panes, counts, hidden }) => {
        const expanded = forceExpand || !collapsed.has(workspace.id);
        const total = panes.reduce((sum, pane) => sum + pane.surfaces.length, 0);
        const workspaceSurfaceCount = workspace.panes.reduce((sum, pane) => sum + pane.surfaces.length, 0);
        // 只有一个 pane 时不必再套一层，少一级缩进。
        const flat = workspace.panes.length === 1;

        return (
          <section className="ws-block" key={workspace.id}>
            <div className="ws-header">
              <button type="button" className="ws-toggle" aria-expanded={expanded} onClick={() => onToggle(workspace.id)}>
              <span className="caret">{expanded ? "▾" : "▸"}</span>
              <span className="ws-name">{workspace.title}</span>
              {workspace.selected ? <span className="chip chip-now">当前</span> : null}
              <span className="ws-counts">
                {counts.NEEDS_YOU > 0 ? (
                  <span className="chip chip-attention">{counts.NEEDS_YOU} 需要你</span>
                ) : null}
                {counts.WORKING > 0 ? <span className="chip chip-working">{counts.WORKING} 运行中</span> : null}
                {!expanded ? <span className="chip">{total} surface</span> : null}
                {/* 被「只看 Agent」藏起来的数量，提示这里还有东西没显示 */}
                {hidden > 0 ? (
                  <span className="chip chip-hidden" title={`还有 ${hidden} 个没有 Agent 的 surface`}>
                    +{hidden}
                  </span>
                ) : null}
              </span>
              </button>
              {onRenameWorkspace ? <RenameMenu value={workspace.title} label="Workspace 名称"
                closeActions={{ workspace: () => onClose(workspace, "workspace"), pane: () => onClose(workspace, "pane") }}
                createLabel="增加 pane" onCreate={onCreatePane ? () => onCreatePane(workspace.id) : undefined}
                onRename={(name) => onRenameWorkspace(workspace.id, name)} /> : null}
            </div>

            {expanded
              ? panes.map(({ pane, key, surfaces }) => {
                  const paneExpanded = flat || forceExpand || !collapsed.has(key);
                  return (
                    <div className="pane-block" key={key}>
                      {flat ? null : (
                        <button type="button" className="pane-header" onClick={() => onToggle(key)}>
                          <span className="caret">{paneExpanded ? "▾" : "▸"}</span>
                          <span>分屏 {workspace.panes.findIndex(p => (p.id ?? p.ref) === (pane.id ?? pane.ref)) + 1} · {pane.ref}</span>
                          <span className="dim">· {surfaces.length} surface</span>
                          {pane.focused ? <span className="chip chip-now">焦点</span> : null}
                        </button>
                      )}
                      {paneExpanded ? (
                        <>
                          {surfaces.map((surface) => (
                            <SurfaceRow
                              key={surface.id}
                              surface={surface}
                              agent={agents.get(surface.id)}
                              now={now}
                              lastInWorkspace={workspaceSurfaceCount <= 1}
                              onOpen={() => navigate({ name: "session", surfaceId: surface.id })}
                            />
                          ))}
                          <NewSurfaceRow workspaceId={workspace.id} pane={pane} navigate={navigate} />
                        </>
                      ) : null}
                    </div>
                  );
                })
              : null}

          </section>
        );
      })}
    </>
  );
}

