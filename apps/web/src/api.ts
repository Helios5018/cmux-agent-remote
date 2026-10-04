import { SurfaceWriteResponseSchema, CreateSurfaceResponseSchema } from "@car/protocol";
import type {
  AgentDetailResponse,
  AgentKind,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  CmuxKey,
  CreateSurfaceResponse,
  Inbox,
  ScrollAction,
  SessionInfo,
  SurfaceGrid,
  SurfaceHistoryResponse,
  SurfaceScrollResponse,
  SurfaceSnapshot,
  SurfaceWriteResponse,
  TreeResponse,
} from "@car/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? "UNKNOWN", error?.message ?? response.statusText);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  session: () => request<SessionInfo>("/api/auth/session"),

  login: (token: string) =>
    request<SessionInfo>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),

  logout: () => request<SessionInfo>("/api/auth/logout", { method: "POST" }),

  agents: () => request<Inbox>("/api/agents"),

  agent: (surfaceId: string) => request<AgentDetailResponse>(`/api/agents/${encodeURIComponent(surfaceId)}`),

  markRead: (surfaceId: string) =>
    request<{ ok: true }>(`/api/agents/${encodeURIComponent(surfaceId)}/read`, { method: "POST" }),

  tree: () => request<TreeResponse>("/api/tree"),

  output: (surfaceId: string) =>
    request<SurfaceSnapshot>(`/api/surfaces/${encodeURIComponent(surfaceId)}/output`),

  /** 彩色渲染网格（颜色 / 粗体 / 反显 / 光标 / 格子宽度）。 */
  grid: (surfaceId: string) => request<SurfaceGrid>(`/api/surfaces/${encodeURIComponent(surfaceId)}/grid`),

  /** 在指定 pane 里新建 terminal surface，launch 非 null 时顺手起一个 Agent。 */
  createSurface: async (paneId: string, workspaceId: string | undefined, launch: AgentKind | null) => {
    const result = await request<CreateSurfaceResponse>("/api/surfaces", {
      method: "POST",
      body: JSON.stringify({ paneId, workspaceId, launch }),
    });
    return CreateSurfaceResponseSchema.parse(result);
  },

  sendInput: async (surfaceId: string, text: string, submit: boolean) => {
    const result = await request<SurfaceWriteResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/input`, {
      method: "POST",
      body: JSON.stringify({ text, submit }),
    });
    if (!SurfaceWriteResponseSchema.safeParse(result).success) {
      throw new ApiError(502, "INPUT_DELIVERY_UNKNOWN", "发送响应无效，结果未知");
    }
    return result;
  },

  /** 关掉 cmux 里的真实 tab。confirm 必须为 true。 */
  closeSurface: (surfaceId: string) =>
    request<SurfaceWriteResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/close`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),

  sendKey: (surfaceId: string, key: CmuxKey, confirm = false, repeat: 1 | 2 = 1) =>
    request<SurfaceWriteResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/key`, {
      method: "POST",
      body: JSON.stringify({ key, confirm, repeat }),
    }),

  renameSurface: (surfaceId: string, title: string) =>
    request<SurfaceWriteResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  closeWorkspace: (workspaceId: string, surfaceIds: string[]) =>
    request<SurfaceWriteResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/close`, {
      method: "POST", body: JSON.stringify({ confirm: true, surfaceIds }),
    }),
  closePane: (workspaceId: string, paneId: string, surfaceIds: string[]) =>
    request<SurfaceWriteResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/panes/${encodeURIComponent(paneId)}/close`, {
      method: "POST", body: JSON.stringify({ confirm: true, surfaceIds }),
    }),

  createWorkspace: (input: CreateWorkspaceRequest) => request<CreateWorkspaceResponse>("/api/workspaces", { method: "POST", body: JSON.stringify(input) }),

  createPane: (workspaceId: string) =>
    request<{ ok: true; workspaceId: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/panes`, { method: "POST" }),

  renameWorkspace: (workspaceId: string, title: string) =>
    request<SurfaceWriteResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  /** 翻页：响应里直接带回滚动后的新画面。 */
  scroll: (surfaceId: string, action: ScrollAction) =>
    request<SurfaceScrollResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/scroll`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  /** 网格之外更早的历史（纯文本）。drop 传当前网格已画出的行数，避免重复。 */
  history: (surfaceId: string, drop: number) =>
    request<SurfaceHistoryResponse>(
      `/api/surfaces/${encodeURIComponent(surfaceId)}/history?drop=${Math.max(0, Math.floor(drop))}`,
    ),
};
