import { nodesText, type InputNode, type FileReference } from "../features/attachments/model.ts";
import { ApiError } from "../api.ts";

export interface Draft {
  text: string;
  nodes?: InputNode[];
  busy: boolean;
  message: string | null;
  uncertain: boolean;
  textWritten: boolean;
  keyUncertain?: boolean;
}
const EMPTY: Draft = Object.freeze({ text: "", busy: false, message: null, uncertain: false, textWritten: false });

export function inputFailure(error: unknown): Pick<Draft, "message" | "uncertain" | "textWritten"> {
  if (error instanceof ApiError && [400, 401, 403, 404, 413, 428, 429].includes(error.status)) {
    return { message: `请求未执行：${error.message}`, uncertain: false, textWritten: false };
  }
  const textWritten = error instanceof ApiError && error.code === "INPUT_TEXT_WRITTEN_SUBMIT_UNKNOWN";
  return {
    message: textWritten
      ? "文本已写入，提交结果未知。请核对终端；若正文仍在输入行，只补发 Enter。"
      : "发送结果未知，草稿已保留。请先核对终端，避免重复输入。",
    uncertain: true, textWritten,
  };
}

/** 当前页面内存状态；离开会话不丢草稿，刷新不落盘。异步结果只更新原会话。 */
export class DraftStore {
  private values = new Map<string, Draft>();
  private listeners = new Map<string, Set<() => void>>();
  get = (id: string): Draft => this.values.get(id) ?? EMPTY;
  subscribe(id: string, listener: () => void): () => void {
    const group = this.listeners.get(id) ?? new Set();
    group.add(listener);
    this.listeners.set(id, group);
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(id); };
  }
  private put(id: string, value: Draft): void {
    this.values.set(id, value);
    this.listeners.get(id)?.forEach(fn => fn());
  }
  edit(id: string, text: string): void {
    const current = this.get(id);
    if (!current.busy && !current.uncertain) this.put(id, { ...current, text, nodes: undefined, message: null });
  }
  editNodes(id: string, nodes: InputNode[]): void {
    const current = this.get(id);
    if (!current.busy && !current.uncertain) this.put(id, { ...current, nodes, text: nodesText(nodes), message: null });
  }
  updateFile(id: string, fileId: string, patch: Partial<FileReference>): void {
    const current = this.get(id);
    if (!current.nodes?.some(n => n.type === "file" && n.id === fileId)) return;
    const nodes = current.nodes.map(n => n.type === "file" && n.id === fileId ? { ...n, ...patch } : n);
    this.put(id, { ...current, nodes, text: nodesText(nodes) });
  }
  resolve(id: string, clear: boolean): void {
    const current = this.get(id);
    if (!current.busy) this.put(id, { ...EMPTY, text: clear ? "" : current.text, nodes: clear ? undefined : current.nodes });
  }
  notice(id: string, message: string): void {
    this.put(id, { ...this.get(id), message });
  }
  async run(id: string, operation: () => Promise<void>, clearOnSuccess: boolean, recovery = false): Promise<boolean> {
    const current = this.get(id);
    if (current.busy || (current.uncertain && !recovery)) return false;
    const pending = { ...current, busy: true, message: null };
    this.put(id, pending);
    try {
      await operation();
      // 登出/关闭会话后忽略迟到响应，不能重新建立已清除的草稿。
      if (this.values.get(id) !== pending) return false;
      this.put(id, { ...EMPTY, text: clearOnSuccess ? "" : current.text, nodes: clearOnSuccess ? undefined : current.nodes,
        message: clearOnSuccess ? "已发送到终端" : "按键已发送到终端" });
      return true;
    } catch (error) {
      if (this.values.get(id) === pending) {
        const failure = inputFailure(error);
        this.put(id, { ...current, busy: false, ...failure,
          ...(!clearOnSuccess && failure.uncertain ? {
            keyUncertain: true, message: "按键结果未知，请核对终端后再操作。草稿已保留。",
          } : {}),
          ...(recovery && current.textWritten ? {
            uncertain: true, textWritten: true,
            message: "文本已写入，本次补发回车仍未确认。请核对终端后继续，避免重复发送正文。",
          } : {}),
        });
      }
      return false;
    }
  }
  forget(id: string): void {
    this.values.delete(id);
    this.listeners.get(id)?.forEach(fn => fn());
  }
  clear(): void { for (const id of [...this.values.keys()]) this.forget(id); }
}
