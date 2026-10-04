import { useElementWidth } from "../hooks/useElementWidth.ts";
import { FileBrowser } from "../features/files/FileBrowser.tsx";
import { isFilesOpen, saveFilesOpen, resetFiles } from "../features/files/state.ts";
import { request } from "../api.ts";
import { alignAfterScroll, type ScrollAlign } from "../features/session/scroll.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentState, ScrollAction } from "@car/protocol";
import { AGENT_DISPLAY_NAME, gridMissingHistoryRows, gridRowCount, STATUS_LABEL } from "@car/protocol";
import { formatAgo, formatDuration } from "@car/shared";
import { Composer } from "../components/Composer.tsx";
import { SessionToolIcon } from "../components/SessionToolIcon.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { DEFAULT_GRID_FONT_SIZE, TerminalGrid, type GridLayout } from "../components/TerminalGrid.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { useAppStore, useSurfaceGrid } from "../stores/AppStore.tsx";
import { findAgent, findSurface } from "../stores/selectors.ts";
import { usePageGesture } from "../hooks/usePageGesture.ts";
import type { Route } from "../hooks/useRouter.ts";

const LAYOUT_KEY = "car.session.layout.v1";
const FONT_KEY = "car.session.font.v1";
const IMMERSIVE_KEY = "car.session.immersive.v1";
// fit 模式下这几个值是缩放倍数的分子：7 ≈ 0.56 倍，30 ≈ 2.4 倍
// （手机上 120 列铺满屏宽只有 5px 高，得能放大到看得清，代价是横向滑动）
const DEFAULT_FONT_SIZE = DEFAULT_GRID_FONT_SIZE;
const MIN_FONT_SIZE = 7;
const MAX_FONT_SIZE = 30;
/** 每点一下按比例缩放，不然从 12.5 调到 30 要点二十次。 */
const FONT_STEP = 1.2;

/** Agent 会话页：使用频率最高的页面。 */
export function SessionPage({
  surfaceId,
  back,
  navigate,
}: {
  surfaceId: string;
  back: () => void;
  navigate: (route: Route) => void;
}) {
  const {
    inbox,
    tree,
    openSession,
    subscribe,
    sendInput,
    sendKey,
    renameSurface,
    scrollSurface,
    loadHistory,
    refreshGrid,
    refreshTree,
    error,
  } = useAppStore();
  const { ref: pageRef, width: pageWidth } = useElementWidth<HTMLDivElement>();
  const splitView = pageWidth >= 1200;
  const [filesOpen, setFilesOpen] = useState(() => isFilesOpen(surfaceId));
  const [fileView, setFileView] = useState(false);
  useEffect(() => {
    const inserted = (event: Event) => { if ((event as CustomEvent<{ surfaceId: string }>).detail.surfaceId === surfaceId) queueMicrotask(() => { if (event.defaultPrevented) setFileView(false); }); };
    window.addEventListener("car:insert-files", inserted);
    return () => window.removeEventListener("car:insert-files", inserted);
  }, [surfaceId]);
  const terminalVisible = !filesOpen || splitView || !fileView;
  useEffect(() => { setFilesOpen(isFilesOpen(surfaceId)); setFileView(false); }, [surfaceId]);
  const toggleFiles = () => { const next = !filesOpen; if (!next) resetFiles(surfaceId); setFilesOpen(next); setFileView(next); saveFilesOpen(surfaceId, next); };
  const [agent, setAgent] = useState<AgentState | null>(() => findAgent(inbox, surfaceId) ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [layoutPref, setLayoutPref] = useState<GridLayout | "auto">(readLayoutPref);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [immersive, setImmersive] = useState(readImmersive);
  const [scrollBusy, setScrollBusy] = useState(false);
  const [alignNonce, setAlignNonce] = useState(0);
  const [history, setHistory] = useState<{ text: string; truncated: boolean } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  // 插入历史后要把视线钉在原来的位置，不然内容整块往下窜
  const keepPositionAfterHistory = useRef(false);
  // 翻页后视线该落在新一屏的哪一头，见 alignAfterScroll
  const pendingAlign = useRef<ScrollAlign | null>(null);
  // 翻过页就说明这个 surface 现在不在最新一屏，离开时要退回去
  const scrolledAway = useRef(false);

  const liveAgent = findAgent(inbox, surfaceId) ?? agent;
  const placement = findSurface(tree, surfaceId);
  const grid = useSurfaceGrid(surfaceId);

  // 自动：全屏 TUI 等比缩放保住边框，普通输出按屏宽软换行
  const layout: GridLayout = layoutPref === "auto" ? (grid?.altScreen ? "fit" : "flow") : layoutPref;

  // store 里的函数会随状态刷新而换引用；用 ref 固定住，
  // 否则一旦请求失败就会「失败 → 状态更新 → 重新请求」无限重试。
  const actionsRef = useRef({ openSession, subscribe, refreshTree, refreshGrid, scrollSurface });
  actionsRef.current = { openSession, subscribe, refreshTree, refreshGrid, scrollSurface };

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    scrolledAway.current = false;
    actionsRef.current.subscribe(surfaceId);
    // 直接从 #/s/:id 进来时树还没拉过，标题要靠它。
    void actionsRef.current.refreshTree();
    void actionsRef.current.refreshGrid(surfaceId);
    void actionsRef.current.openSession(surfaceId).then((result) => {
      if (result && !cancelled) setAgent(result);
    });
    return () => {
      cancelled = true;
      actionsRef.current.subscribe(null);
      // 翻页动的是 Mac 上那块真实画面，离开前退回最新一屏，
      // 否则本人坐到电脑前会发现终端莫名其妙停在半路。
      if (scrolledAway.current) void actionsRef.current.scrollSurface(surfaceId, "bottom").catch(() => undefined);
    };
  }, [surfaceId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, layoutPref);
      window.localStorage.setItem(FONT_KEY, String(fontSize));
      window.localStorage.setItem(IMMERSIVE_KEY, immersive ? "1" : "0");
    } catch {
      // 隐私模式写不了，忽略
    }
  }, [layoutPref, fontSize, immersive]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /*
   * 新画面到位后把视线放到该在的地方。
   *
   * 翻页的落点优先于「贴底」：这两件事经常冲突 —— 往下翻一屏，接缝在新一屏的
   * 顶部，可贴底会立刻把它拽到末尾。
   */
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (!element) return;
    const align = pendingAlign.current;
    if (align) {
      pendingAlign.current = null;
      element.scrollTop = align === "top" ? 0 : element.scrollHeight;
      return;
    }
    // 只有用户本来就贴着底部时才自动滚动，避免打断向上翻阅
    if (!stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [grid?.revision, layout, fontSize, alignNonce]);

  // 窄屏文件页会隐藏终端；切回来时即使网格 revision 不变，也要重新贴底。
  useLayoutEffect(() => {
    if (!terminalVisible) return;
    pendingAlign.current = null;
    stickToBottom.current = true;
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [terminalVisible]);

  // 历史插在网格上方，会把网格整块顶下去；补上同样的高度，视线才不会跳
  useLayoutEffect(() => {
    if (!keepPositionAfterHistory.current) return;
    keepPositionAfterHistory.current = false;
    const element = outputRef.current;
    const block = historyRef.current;
    if (element && block) element.scrollTop += block.offsetHeight;
  }, [history]);

  useEffect(() => {
    if (terminalVisible || !scrolledAway.current) return;
    scrolledAway.current = false;
    stickToBottom.current = true;
    setHistory(null);
    void actionsRef.current.scrollSurface(surfaceId, "bottom").catch(() => undefined);
  }, [terminalVisible, surfaceId]);

  const missingHistory = grid ? gridMissingHistoryRows(grid) : 0;

  const onScroll = () => {
    const element = outputRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 40;
    // 普通屏往上翻到头就自动把更早的历史接上，不用先看见按钮再去点
    if (element.scrollTop < 48 && missingHistory > 0 && !history && !historyBusy) void loadEarlier();
  };

  const scrollPage = async (action: ScrollAction) => {
    if (scrollBusy) return;
    setScrollBusy(true);
    try {
      // 翻页之后网格换了一屏，之前按旧网格裁出来的历史对不上了
      setHistory(null);
      scrolledAway.current = action !== "bottom";
      pendingAlign.current = alignAfterScroll(action);
      /*
       * 只有回到最新一屏才继续跟着新输出跑。停在历史屏上还贴底的话，
       * Agent 每吐一次新内容都会把画面拽走，想多看两眼都待不住。
       */
      stickToBottom.current = action === "bottom";
      await scrollSurface(surfaceId, action);
    } catch {
      // 错误已由 Store 展示；失败时不按成功画面调整视线。
      pendingAlign.current = null;
    } finally {
      setScrollBusy(false);
      // 画面内容可能和翻页前一模一样（revision 不变），那样上面的 effect 不会重跑，
      // 落点就会一直挂着不生效 —— 用这个计数逼它走一次。
      setAlignNonce((current) => current + 1);
    }
  };

  // 全屏 TUI 一屏就是全部，浏览器根本没有可滚的区域 —— 滑到边继续滑就翻页
  const { dragOffset, armed } = usePageGesture({
    scrollerRef: outputRef,
    enabled: grid?.altScreen === true && terminalVisible,
    busy: scrollBusy,
    onPage: (direction) => void scrollPage(direction === "up" ? "pageup" : "pagedown"),
  });

  const zoomFont = (factor: number) =>
    setFontSize((size) =>
      Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size * factor)) * 10) / 10,
    );

  const loadEarlier = async () => {
    if (!grid || historyBusy) return;
    // 人都翻到最上面了，别再让新输出把画面拽回底部
    stickToBottom.current = false;
    setHistoryBusy(true);
    try {
      const result = await loadHistory(surfaceId, gridRowCount(grid));
      if (result) {
        keepPositionAfterHistory.current = true;
        setHistory({ text: result.text, truncated: result.truncated });
      }
    } finally {
      setHistoryBusy(false);
    }
  };

  // 主标题用 surface 名，workspace 名放到副标题里做归属说明。
  const title = liveAgent?.surfaceTitle || placement?.surface.title || "会话";
  const workspaceTitle = liveAgent?.workspaceTitle ?? placement?.workspace.title;
  const workspaceId = liveAgent?.workspaceId ?? placement?.workspace.id;
  const kindLabel = liveAgent
    ? AGENT_DISPLAY_NAME[liveAgent.agent]
    : placement?.surface.type === "terminal" || !placement
      ? "Shell"
      : placement.surface.type;

  const runningFor =
    liveAgent?.status === "WORKING" && liveAgent.turnStartedAt
      ? `Running ${formatDuration(now - liveAgent.turnStartedAt)}`
      : liveAgent
        ? `更新于 ${formatAgo(liveAgent.lastActivityAt, now)}`
        : "";

  return (
    <div ref={pageRef} className={`page session-page${immersive && terminalVisible ? " immersive" : ""}`}>
      <TopBar
        right={filesOpen && !splitView ? <div className="session-file-tabs" role="tablist" aria-label="详情页模块"><button role="tab" aria-selected={!fileView} onClick={() => setFileView(false)}>会话</button><button role="tab" aria-selected={fileView} onClick={() => setFileView(true)}>文件</button></div> : undefined}
        fileAction={{ label: filesOpen ? "关闭文件系统" : "打开文件系统", run: toggleFiles }}
        title={title}
        onBack={back}
        onRename={(name) => {
          const next = name.trim();
          if (!next || next === title) return;
          void renameSurface(surfaceId, next);
        }}
        renameMaxLength={80}
        renamePlaceholder={title}
        renameAriaLabel="Surface 名称"
      />

      <div className={`session-content${filesOpen && splitView ? " split-view" : ""}`}>
      <div className="session-terminal" hidden={!terminalVisible}>
      <div className="session-header">
        <div className="session-agent">{kindLabel}</div>
        {liveAgent ? <StatusBadge status={liveAgent.status} /> : null}
        {workspaceTitle ? (
          <button
            type="button"
            className="ws-chip ws-chip-button"
            title="查看该 workspace 的结构"
            onClick={() => (workspaceId ? navigate({ name: "workspace", workspaceId }) : undefined)}
          >
            ▤ {workspaceTitle}
          </button>
        ) : null}
        <div className="session-timing">{runningFor}</div>
        {liveAgent?.currentActivity ? <div className="session-activity">{liveAgent.currentActivity}</div> : null}
        {liveAgent?.status === "POSSIBLY_STALE" ? (
          <div className="session-warning">
            {STATUS_LABEL.POSSIBLY_STALE} · No activity for{" "}
            {Math.floor((now - liveAgent.lastActivityAt) / 60000)}m
          </div>
        ) : null}
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      {/* 翻页手势的状态提示，浮在终端上方，不占布局高度 */}
      {armed || scrollBusy ? (
        <div className="page-hint">
          {scrollBusy ? "翻页中…" : armed === "up" ? "松手看上一屏" : "松手看下一屏"}
        </div>
      ) : null}

      <div className="output" ref={outputRef} onScroll={onScroll}>
        <div
          className={`output-drag${dragOffset === 0 ? "" : " dragging"}`}
          style={dragOffset === 0 ? undefined : { transform: `translateY(${dragOffset}px)` }}
        >
          {grid ? (
            <>
              {/* 网格之外更早的历史：纯文本、无颜色，cmux 那一层就没给。 */}
              {history ? (
                <div className="history-block" ref={historyRef}>
                  {history.truncated ? (
                    <div className="history-note dim">（更早的内容已超出回溯上限）</div>
                  ) : null}
                  <pre className="history-text">{history.text}</pre>
                  <div className="history-divider">
                    <span>以上为纯文本历史 · 以下为实时画面</span>
                  </div>
                </div>
              ) : missingHistory > 0 ? (
                <div className="history-block" ref={historyRef}>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={historyBusy}
                    onClick={() => void loadEarlier()}
                  >
                    {historyBusy ? "读取中…" : `加载更早的历史（约 ${missingHistory} 行，纯文本）`}
                  </button>
                </div>
              ) : null}

              <TerminalGrid grid={grid} layout={layout} baseFontSize={fontSize} />
            </>
          ) : (
            <div className="output-empty dim">（正在读取终端画面…）</div>
          )}
        </div>
      </div>

      <div className="session-tools" role="group" aria-label="终端工具">
        {/*
          翻页只给全屏 TUI 用：它的历史在程序自己手里，终端这层一行 scrollback 都没有。
          普通屏有真正的回滚，往上翻看「加载更早的历史」就够了，
          而且实测普通屏里跑的 CLI 未必理会 pageup，摆个点不动的按钮更糟。
        */}
        {grid?.altScreen ? (
          <div className="session-scroll-group">
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label="上一屏"
              title="上一屏（也可以直接往下滑）。让终端里的程序自己往回翻，Mac 上那块画面会跟着动，离开会话时自动回到最新"
              disabled={scrollBusy}
              onClick={() => void scrollPage("pageup")}
            >
              <SessionToolIcon name="page-up" />
            </button>
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label="下一屏"
              title="下一屏（也可以直接往上滑）"
              disabled={scrollBusy}
              onClick={() => void scrollPage("pagedown")}
            >
              <SessionToolIcon name="page-down" />
            </button>
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label="回到最新"
              title="回到最新一屏"
              disabled={scrollBusy}
              onClick={() => void scrollPage("bottom")}
            >
              <SessionToolIcon name="bottom" />
            </button>
          </div>
        ) : null}

        <div className="session-tools-right">
          <div className="session-font-group">
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label="缩小终端"
              title="缩小（TUI 下是整屏缩放，一屏能塞下更多行）"
              disabled={fontSize <= MIN_FONT_SIZE}
              onClick={() => zoomFont(1 / FONT_STEP)}
            >
              <SessionToolIcon name="zoom-out" />
            </button>
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label="放大终端"
              title="放大（TUI 下超过屏宽就横向滑动看）"
              disabled={fontSize >= MAX_FONT_SIZE}
              onClick={() => zoomFont(FONT_STEP)}
            >
              <SessionToolIcon name="zoom-in" />
            </button>
          </div>
          <div className="session-view-group">
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label={`显示方式：${layoutPref === "auto" ? "自动" : layoutPref === "fit" ? "缩放" : "换行"}`}
              title={
                layoutPref === "auto"
                  ? "当前：自动（TUI 缩放 / 普通输出换行）"
                  : layoutPref === "fit"
                    ? "当前：整屏缩放到屏宽"
                    : "当前：按屏宽换行"
              }
              onClick={() =>
                setLayoutPref((current) =>
                  current === "auto" ? "fit" : current === "fit" ? "flow" : "auto",
                )
              }
            >
              <SessionToolIcon name={layoutPref} />
            </button>
            <button
              type="button"
              className="chip-button session-tool-button"
              aria-label={immersive ? "退出沉浸模式" : "进入沉浸模式"}
              aria-pressed={immersive}
              title={immersive ? "退出沉浸模式" : "沉浸模式：收起标题和状态栏，把屏幕都留给终端"}
              onClick={() => setImmersive((current) => !current)}
            >
              <SessionToolIcon name={immersive ? "collapse" : "expand"} />
            </button>
            <button type="button" className="chip-button session-tool-button" aria-label="刷新终端" title="刷新终端" onClick={() => void refreshGrid(surfaceId)}>
              <SessionToolIcon name="refresh" />
            </button>
          </div>
        </div>
      </div>

      {/*
        发送失败时异常会往上抛给 Composer（它据此保住输入内容并提示原因），
        无论成功失败都刷新画面；反馈保存在会话草稿中，不依赖全局 error。
      */}
      <Composer
        key={surfaceId}
        surfaceId={surfaceId}
        collapsible={immersive}
        agentKind={liveAgent?.agent ?? placement?.surface.agent}
        onSend={async (text, submit) => {
          try { await sendInput(surfaceId, text, submit); }
          finally { void refreshGrid(surfaceId); }
        }}
        onKey={async (key, confirm, repeat) => {
          try { await sendKey(surfaceId, key, confirm, repeat); }
          finally { void refreshGrid(surfaceId); }
        }}
      />
      </div>
      {filesOpen && (splitView || fileView) && <FileBrowser key={surfaceId} scopeId={surfaceId} onClose={toggleFiles} workDirectory={async () => (await request<{ path: string | null }>(`/api/agents/${encodeURIComponent(surfaceId)}/cwd`)).path} />}
      </div>
    </div>
  );
}

function readLayoutPref(): GridLayout | "auto" {
  try {
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    if (saved === "fit" || saved === "flow") return saved;
  } catch {
    // 读不到就用自动
  }
  return "auto";
}

function readFontSize(): number {
  try {
    const saved = Number(window.localStorage.getItem(FONT_KEY));
    if (Number.isFinite(saved) && saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE) return saved;
  } catch {
    // 读不到就用默认字号
  }
  return DEFAULT_FONT_SIZE;
}

function readImmersive(): boolean {
  try {
    return window.localStorage.getItem(IMMERSIVE_KEY) === "1";
  } catch {
    return false;
  }
}
