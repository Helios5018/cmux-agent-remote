import type { SurfaceSnapshot } from "@car/protocol";
import { fingerprint, lastLines, tidyTerminalText } from "@car/shared";

/**
 * Surface 输出处理。
 *
 * cmux `read-screen --json` 返回 { text, base64, surface_id, ... }，
 * 这里负责清洗 ANSI、裁剪行数，并维护「内容没变就不推送」所需的 revision。
 */

export interface ParsedScreen {
  surfaceId?: string;
  surfaceRef?: string;
  workspaceId?: string;
  text: string;
}

export function parseReadScreenJson(raw: unknown): ParsedScreen {
  const root = (raw ?? {}) as Record<string, unknown>;
  const base64 = typeof root["base64"] === "string" ? root["base64"] : undefined;
  const plain = typeof root["text"] === "string" ? root["text"] : undefined;
  // base64 是完整屏幕内容，text 字段在部分版本里会被裁剪，优先用 base64。
  let text = plain ?? "";
  if (base64) {
    try {
      text = Buffer.from(base64, "base64").toString("utf8");
    } catch {
      text = plain ?? "";
    }
  }
  return {
    surfaceId: typeof root["surface_id"] === "string" ? root["surface_id"] : undefined,
    surfaceRef: typeof root["surface_ref"] === "string" ? root["surface_ref"] : undefined,
    workspaceId: typeof root["workspace_id"] === "string" ? root["workspace_id"] : undefined,
    text,
  };
}

export interface SnapshotOptions {
  /** 最多保留多少行。 */
  maxLines?: number;
}

/**
 * 维护每个 surface 的 revision：内容指纹变化才 +1。
 * 这样 WebSocket 层可以做到「内容没变化时不向浏览器推送」。
 */
export class SnapshotTracker {
  private readonly state = new Map<
    string,
    { revision: number; print: string; content: string; changedAt: number; fetchedAt: number }
  >();

  constructor(private readonly options: SnapshotOptions = {}) {}

  /** 返回快照，以及内容是否发生了变化。 */
  update(surfaceId: string, rawText: string, now: number, extra?: { surfaceRef?: string; workspaceId?: string }): {
    snapshot: SurfaceSnapshot;
    changed: boolean;
  } {
    const maxLines = this.options.maxLines ?? 400;
    const content = lastLines(tidyTerminalText(rawText), maxLines);
    const print = fingerprint(content);
    const previous = this.state.get(surfaceId);
    const changed = previous === undefined || previous.print !== print;
    const revision = changed ? (previous?.revision ?? 0) + 1 : previous.revision;
    this.state.set(surfaceId, {
      revision,
      print,
      content,
      changedAt: changed ? now : previous.changedAt,
      fetchedAt: now,
    });

    return {
      snapshot: {
        surfaceId,
        surfaceRef: extra?.surfaceRef,
        workspaceId: extra?.workspaceId,
        content,
        revision,
        fetchedAt: now,
      },
      changed,
    };
  }

  get(surfaceId: string): SurfaceSnapshot | undefined {
    const entry = this.state.get(surfaceId);
    if (!entry) return undefined;
    return {
      surfaceId,
      content: entry.content,
      revision: entry.revision,
      fetchedAt: entry.fetchedAt,
    };
  }

  /** 最近一次内容变化的时间，用来推断「输出是否还在动」。 */
  lastChangedAt(surfaceId: string): number | undefined {
    return this.state.get(surfaceId)?.changedAt;
  }

  /** 最近一次读取时间。 */
  lastFetchedAt(surfaceId: string): number | undefined {
    return this.state.get(surfaceId)?.fetchedAt;
  }

  forget(surfaceId: string): void {
    this.state.delete(surfaceId);
  }
}
