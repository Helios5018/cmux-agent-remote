import { DraftStore } from "./drafts.ts";
import { SurfaceCache } from "./surface-cache.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  AgentKind,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  AgentState,
  CmuxKey,
  CreateSurfaceResponse,
  CmuxSurface,
  CmuxTree,
  CmuxWorkspace,
  Inbox,
  ScrollAction,
  ServerMessage,
  SessionInfo,
  SurfaceGrid,
  SurfaceHistoryResponse,
} from "@car/protocol";
import { patchAgent } from "./selectors.ts";
import { api, ApiError } from "../api.ts";
import { useRealtime, type ConnectionState } from "../hooks/useRealtime.ts";

interface AppStoreValue {
  session: SessionInfo | null;
  loading: boolean;
  inbox: Inbox | null;
  /** cmux 真实结构：Workspace → Pane → Surface，首页直接按它渲染。 */
  tree: CmuxTree | null;
  connection: ConnectionState;
  error: string | null;
  surfaceCache: SurfaceCache;
  drafts: DraftStore;

  login(token: string): Promise<void>;
  logout(): Promise<void>;
  refreshInbox(): Promise<void>;
  refreshTree(): Promise<void>;
  openSession(surfaceId: string): Promise<AgentState | null>;
  /**
   * 在某个 pane 里新建一个 surface；成功后拓扑已刷新。
   * 和其它写操作一样：失败会抛出，调用方要据此给出可见的反馈。
   */
  createSurface(
    paneId: string,
    workspaceId: string | undefined,
    launch: AgentKind | null,
  ): Promise<CreateSurfaceResponse>;
  subscribe(surfaceId: string | null): void;
  /** 写操作失败会抛出 —— 调用方要据此保住用户没发出去的内容。 */
  sendInput(surfaceId: string, text: string, submit: boolean): Promise<void>;
  sendKey(surfaceId: string, key: CmuxKey, confirm?: boolean, repeat?: 1 | 2): Promise<void>;
  renameSurface(surfaceId: string, title: string): Promise<void>;
  closeWorkspace(workspaceId: string, surfaceIds: string[]): Promise<void>;
  closePane(workspaceId: string, paneId: string, surfaceIds: string[]): Promise<void>;
  createWorkspace(input: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse>;
  createPane(workspaceId: string): Promise<string>;
  renameWorkspace(workspaceId: string, title: string): Promise<void>;
  /** 关掉 cmux 里的真实 tab；失败会抛出。 */
  closeSurface(surfaceId: string): Promise<void>;
  /** 翻页，成功后网格直接被替换成滚动后的画面。 */
  scrollSurface(surfaceId: string, action: ScrollAction): Promise<void>;
  /** 拉网格之外更早的历史（纯文本）。 */
  loadHistory(surfaceId: string, drop: number): Promise<SurfaceHistoryResponse | null>;
  refreshGrid(surfaceId: string): Promise<void>;
  clearError(): void;
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [tree, setTree] = useState<CmuxTree | null>(null);
  const [drafts] = useState(() => new DraftStore());
  const [surfaceCache] = useState(() => new SurfaceCache());
  const requestEpoch = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const authenticated = session?.authenticated === true;
  const viewingRef = useRef<string | null>(null);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "agent.list_changed":
        setInbox(message.inbox);
        break;
      case "agent.status_changed":
        setInbox((current) => patchAgent(current, message.agent));
        break;
      case "surface.grid":
        surfaceCache.set(message.surfaceId, message.grid);
        break;
      default:
        break;
    }
  }, [surfaceCache]);

  const { state: connection, subscribe: subscribeRealtime } = useRealtime({ enabled: authenticated, onMessage: handleMessage });

  const subscribe = useCallback((surfaceId: string | null) => {
    viewingRef.current = surfaceId;
    subscribeRealtime(surfaceId);
  }, [subscribeRealtime]);

  /** 统一处理接口错误。401 要把本地会话标成未登录。 */
  const noteApiError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError) {
      if (caught.status === 401) setSession((s) => (s ? { ...s, authenticated: false } : null));
      setError(caught.message);
    } else {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const withError = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      const epoch = requestEpoch.current;
      try {
        const result = await fn();
        if (epoch !== requestEpoch.current) return null;
        setError(null);
        return result;
      } catch (caught) {
        if (epoch !== requestEpoch.current) return null;
        noteApiError(caught);
        return null;
      }
    },
    [noteApiError],
  );

  const write = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      setError(null);
      return result;
    } catch (caught) {
      noteApiError(caught);
      throw caught;
    }
  }, [noteApiError]);

  const refreshInbox = useCallback(async () => {
    const result = await withError(() => api.agents());
    if (result) setInbox(result);
  }, [withError]);

  const refreshTree = useCallback(async () => {
    const result = await withError(() => api.tree());
    if (result) {
      setTree(result);
      surfaceCache.retain(new Set(result.workspaces.flatMap(w => w.panes.flatMap(p => p.surfaces.map(s => s.id)))));
    }
  }, [withError, surfaceCache]);

  const refreshGrid = useCallback(
    async (surfaceId: string) => {
      const grid = await withError(() => api.grid(surfaceId));
      if (grid) surfaceCache.set(surfaceId, grid);
    },
    [withError, surfaceCache],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.session();
        if (!cancelled) setSession(info);
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authenticated) void refreshInbox();
  }, [authenticated, refreshInbox]);

  const resync = useCallback(async () => {
    await Promise.all([refreshInbox(), refreshTree(),
      ...(viewingRef.current ? [refreshGrid(viewingRef.current)] : []),
    ]);
  }, [refreshInbox, refreshTree, refreshGrid]);

  useEffect(() => {
    if (authenticated && connection === "open") void resync();
  }, [authenticated, connection, resync]);

  // 断线时列表、拓扑和当前画面一起降级；单轮完成前不发起下一轮。

  useEffect(() => {
    if (!authenticated || connection === "open") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "visible") await resync();
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [authenticated, connection, resync]);

  useEffect(() => {
    if (!authenticated) {
      requestEpoch.current += 1;
      surfaceCache.clear();
    }
  }, [authenticated, surfaceCache]);

  const actions = useMemo<Omit<AppStoreValue, "session" | "loading" | "inbox" | "tree" | "connection" | "error" | "surfaceCache" | "drafts">>(
    () => ({

      async login(token: string) {
        const info = await withError(() => api.login(token));
        if (info) setSession(info);
      },

      async logout() {
        const info = await withError(() => api.logout());
        if (!info) return;
        drafts.clear();
        setSession(info);
        setInbox(null);
        setTree(null);
        requestEpoch.current += 1;
        surfaceCache.clear();
      },

      refreshInbox,
      refreshTree,

      async openSession(surfaceId: string) {
        // 非 Agent 的 surface（shell / browser）没有 Agent 状态，
        // 但照样能看画面、发输入，所以 404 不算错误，直接退化成读输出。
        const epoch = requestEpoch.current;
        let detail: Awaited<ReturnType<typeof api.agent>> | null = null;
        try {
          detail = await api.agent(surfaceId);
          if (epoch !== requestEpoch.current) return null;
          setError(null);
        } catch (caught) {
          if (epoch !== requestEpoch.current) return null;
          if (caught instanceof ApiError && caught.status === 404) {
            // 非 Agent 的 surface 没有状态，但照样能看彩色画面
            await refreshGrid(surfaceId);
            return null;
          }
          if (caught instanceof ApiError && caught.status === 401) {
            setSession((s) => (s ? { ...s, authenticated: false } : null));
          }
          setError(caught instanceof Error ? caught.message : String(caught));
          return null;
        }
        setInbox((current) => patchAgent(current, detail.agent));
        return detail.agent;
      },

      async createSurface(paneId: string, workspaceId: string | undefined, launch: AgentKind | null) {
        // 和 sendInput 一样失败即抛出：调用方要就地说明「为什么没建成」，
        // 吞成 null 的话按钮点下去毫无动静，和坏了没区别。
        try {
          const result = await api.createSurface(paneId, workspaceId, launch);
          setError(null);
          if (result.launchError) drafts.notice(result.surfaceId, result.launchError.message);
          // 新 tab 得立刻出现在结构树里，否则跳过去会看到「找不到 surface」。
          await refreshTree();
          return result;
        } catch (caught) {
          noteApiError(caught);
          throw caught;
        }
      },

      subscribe,

      /*
       * 写操作故意不走 withError：它把异常吞成 null，调用方分不清成功还是失败，
       * Composer 就会在发送失败后照样清空输入框 —— 表现出来就是「点了没反应，字还没了」。
       */
      sendInput: (surfaceId: string, text: string, submit: boolean) =>
        write(async () => { await api.sendInput(surfaceId, text, submit); }),

      sendKey: (surfaceId: string, key: CmuxKey, confirm = false, repeat: 1 | 2 = 1) =>
        write(async () => { await api.sendKey(surfaceId, key, confirm, repeat); }),

      async renameSurface(surfaceId: string, title: string) {
        try {
          await api.renameSurface(surfaceId, title);
          setError(null);
          await Promise.all([refreshTree(), refreshInbox()]);
        } catch (caught) {
          noteApiError(caught);
          throw caught;
        }
      },

      closeWorkspace: (workspaceId, surfaceIds) => write(async () => {
        try { await api.closeWorkspace(workspaceId, surfaceIds); surfaceIds.forEach(id => drafts.forget(id)); }
        finally { await Promise.all([refreshTree(), refreshInbox()]); }
      }),
      closePane: (workspaceId, paneId, surfaceIds) => write(async () => {
        try { await api.closePane(workspaceId, paneId, surfaceIds); surfaceIds.forEach(id => drafts.forget(id)); }
        finally { await Promise.all([refreshTree(), refreshInbox()]); }
      }),

      createWorkspace: (input) => write(async () => {
        const result = await api.createWorkspace(input);
        await Promise.allSettled([refreshTree(), refreshInbox()]);
        return result;
      }),

      createPane: (workspaceId: string) => write(async () => {
        const result = await api.createPane(workspaceId);
        await Promise.all([refreshTree(), refreshInbox()]);
        return result.workspaceId;
      }),

      async renameWorkspace(workspaceId: string, title: string) {
        try {
          await api.renameWorkspace(workspaceId, title);
          setError(null);
          await Promise.all([refreshTree(), refreshInbox()]);
        } catch (caught) {
          noteApiError(caught);
          throw caught;
        }
      },

      async closeSurface(surfaceId: string) {
        try {
          await api.closeSurface(surfaceId);
          setError(null);
          surfaceCache.forget(surfaceId);
          drafts.forget(surfaceId);
          await Promise.all([refreshTree(), refreshInbox()]);
        } catch (caught) {
          noteApiError(caught);
          throw caught;
        }
      },

      async scrollSurface(surfaceId: string, action: ScrollAction) {
        const result = await write(() => api.scroll(surfaceId, action));
        if (result) surfaceCache.set(surfaceId, result.grid);
      },

      loadHistory: (surfaceId: string, drop: number) => withError(() => api.history(surfaceId, drop)),

      refreshGrid,

      clearError: () => setError(null),
    }),
    [
      surfaceCache,
      drafts,
      write,
      refreshInbox,
      refreshTree,
      refreshGrid,
      subscribe,
      withError,
      noteApiError,
    ],
  );

  const value = useMemo(() => ({ session, loading, inbox, tree, connection, error, surfaceCache, drafts, ...actions }),
    [session, loading, inbox, tree, connection, error, surfaceCache, drafts, actions]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStoreValue {
  const value = useContext(AppStoreContext);
  if (!value) throw new Error("useAppStore 必须在 AppStoreProvider 内使用");
  return value;
}


/** 只订阅当前终端帧，不让网格变化重渲染整棵应用树。 */
export function useSurfaceGrid(surfaceId: string): SurfaceGrid | undefined {
  const { surfaceCache } = useAppStore();
  const subscribe = useCallback((listener: () => void) => surfaceCache.subscribe(surfaceId, listener), [surfaceCache, surfaceId]);
  const snapshot = useCallback(() => surfaceCache.get(surfaceId), [surfaceCache, surfaceId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
