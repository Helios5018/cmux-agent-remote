import { InlineEditor, type InlineEditorHandle } from "../features/attachments/InlineEditor.tsx";
import { AttachmentControls, ReferenceDetails } from "../features/attachments/AttachmentControls.tsx";
import { referenceForPath, type InputNode, type FileReference } from "../features/attachments/model.ts";
import { uploadReference } from "../features/attachments/upload.ts";
import "../features/attachments/attachments.css";
import { useAppStore } from "../stores/AppStore.tsx";
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import type { AgentKind, CmuxKey } from "@car/protocol";
import { DANGEROUS_KEY_HINT, isDangerousKey } from "@car/protocol";

/** 粘贴（或合成后的文本）达到这么多行，自动进展开编辑。 */
export const PASTE_EXPAND_LINES = 8;
/** 紧凑态自动长高上限：窗口高度的这一比例，再多就框内滚动。 */
export const AUTO_GROW_MAX_RATIO = 0.4;

export function countTextLines(text: string): number {
  if (text.length === 0) return 1;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export function shouldExpandEditorForText(text: string, threshold = PASTE_EXPAND_LINES): boolean {
  return countTextLines(text) >= threshold;
}

/** 把粘贴结果拼进当前选区，用来在 paste 事件里预判要不要放大。 */
export function applyPaste(text: string, pasted: string, start: number, end: number): string {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return text.slice(0, from) + pasted + text.slice(to);
}

interface KeyButton {
  key: CmuxKey;
  label: string;
  title: string;
  repeat?: 1 | 2;
}

/**
 * 按键条按用途分组，一行横向滑动。
 * 手机屏幕放不下这么多键，分组 + 横滑比换行更像原生键盘条。
 */
const KEY_GROUPS: KeyButton[][] = [
  [
    { key: "enter", label: "Enter", title: "回车 / 确认" },
    { key: "escape", label: "Esc", title: "取消 / 退出当前状态" },
    { key: "tab", label: "Tab", title: "补全 / 切换" },
  ],
  [
    { key: "up", label: "↑", title: "上（历史 / 选项）" },
    { key: "down", label: "↓", title: "下（历史 / 选项）" },
    { key: "left", label: "←", title: "左" },
    { key: "right", label: "→", title: "右" },
  ],
];

const INTERRUPT_KEY: KeyButton = {
  key: "ctrl+c",
  label: "Ctrl+C",
  title: DANGEROUS_KEY_HINT["ctrl+c"] ?? "中断",
};

/** Pi 用 Ctrl+P 打开模型选择器；其他 Agent 不展示这个专属快捷键。 */
export function composerKeysForAgent(agentKind?: AgentKind | null): CmuxKey[] {
  return keyGroupsForAgent(agentKind).flatMap((group) => group.map(({ key }) => key));
}

function keyGroupsForAgent(agentKind?: AgentKind | null): KeyButton[][] {
  return [
    ...KEY_GROUPS,
    [
      INTERRUPT_KEY,
      ...(agentKind && ["pi", "claude", "codex", "grok"].includes(agentKind)
        ? [{ key: "ctrl+c" as const, repeat: 2 as const, label: "Ctrl+C ×2", title: "连续发送两次 Ctrl+C，尝试退出 Agent" }]
        : []),
      ...(agentKind === "pi"
        ? [{ key: "ctrl+p" as const, label: "Ctrl+P", title: "切换 Pi 模型" }]
        : []),
      ...(agentKind === "codex"
        ? [{ key: "alt+up" as const, label: "⌥↑", title: "Option+↑：打开 Codex 排队消息 / 异步提问" }]
        : []),
    ],
  ];
}

/** 输入框角上的放大/还原标记，不要做成独立大按钮。 */
function SizeGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d={
          expanded
            ? "M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"
            : "M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Composer({
  surfaceId,
  collapsible = false,
  agentKind,
  onSend,
  onKey,
}: {
  surfaceId: string;
  /** 沉浸模式下先收成一条，点开才展开 —— 输入框 + 按键条在手机上要吃掉小半屏。 */
  collapsible?: boolean;
  /** Pi 会额外显示用于快速切换模型的 Ctrl+P。 */
  agentKind?: AgentKind | null;
  onSend: (text: string, submit: boolean) => Promise<void>;
  onKey: (key: CmuxKey, confirm: boolean, repeat?: 1 | 2) => Promise<void>;
}) {
  const { drafts } = useAppStore();
  const subscribeDraft = useCallback((listener: () => void) => drafts.subscribe(surfaceId, listener), [drafts, surfaceId]);
  const snapshot = useCallback(() => drafts.get(surfaceId), [drafts, surfaceId]);
  const draft = useSyncExternalStore(subscribeDraft, snapshot, snapshot);
  const { text, busy, message: failure, uncertain, textWritten } = draft;
  const nodes: InputNode[] = draft.nodes ?? (text ? [{ type: "text", text }] : []);
  const blockedFiles = nodes.some(n => n.type === "file" && n.status !== "ready");
  const tooLong = text.length > 20000;
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const reference = nodes.find((n): n is FileReference => n.type === "file" && n.id === selectedReference);
  const insertNodes = (inserted: InputNode[]) => {
    if (busy || uncertain) return;
    if (textareaRef.current) textareaRef.current.insert(inserted);
    else { drafts.editNodes(surfaceId, [...nodes, ...inserted]); setExpanded(true); }
  };
  const insertPaths = (paths: string[]) => insertNodes(paths.flatMap(path => [referenceForPath(path), { type: "text" as const, text: " " }]));
  const uploadFiles = (files: File[]) => {
    if (busy || uncertain) return;
    const refs: FileReference[] = files.map(file => ({ type: "file", id: crypto.randomUUID(), name: file.name, size: file.size, file, status: "uploading", progress: 0 }));
    insertNodes(refs.flatMap(ref => [ref, { type: "text" as const, text: " " }]));
    refs.forEach(ref => uploadReference(drafts, surfaceId, ref));
  };
  useEffect(() => {
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<{ surfaceId: string; paths: string[] }>).detail;
      if (detail.surfaceId === surfaceId && !busy && !uncertain) { insertPaths(detail.paths); event.preventDefault(); requestAnimationFrame(() => textareaRef.current?.focus()); }
    };
    window.addEventListener("car:insert-files", insert);
    return () => window.removeEventListener("car:insert-files", insert);
  });
  const [expanded, setExpanded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingKey, setPendingKey] = useState<{ key: CmuxKey; repeat: 1 | 2 } | null>(null);
  // 中文输入法组字期间不能提交
  const keyBarRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<InlineEditorHandle | null>(null);
  // 两端是否还有没滑到的键，用来决定要不要显示渐隐提示
  const [edges, setEdges] = useState({ start: false, end: false });

  const syncEdges = () => {
    const element = keyBarRef.current;
    if (!element) return;
    const start = element.scrollLeft > 4;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 4;
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }));
  };

  useEffect(() => {
    syncEdges();
    window.addEventListener("resize", syncEdges);
    return () => window.removeEventListener("resize", syncEdges);
  }, []);

  const syncTextareaHeight = () => {
    const element = textareaRef.current?.element();
    if (!element) return;
    if (editorOpen) {
      element.style.height = "";
      element.style.overflowY = "auto";
      return;
    }
    element.style.height = "auto";
    const maxPx = Math.round(window.innerHeight * AUTO_GROW_MAX_RATIO);
    const next = Math.min(element.scrollHeight, maxPx);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > maxPx ? "auto" : "hidden";
  };

  useLayoutEffect(syncTextareaHeight, [text, editorOpen]);

  useEffect(() => {
    window.addEventListener("resize", syncTextareaHeight);
    return () => window.removeEventListener("resize", syncTextareaHeight);
  }, [editorOpen]);

  // 展开编辑时按可视视口封顶，避开 iOS 键盘把 Send 顶没
  useEffect(() => {
    const root = composerRef.current;
    if (!root || !editorOpen) return;
    const apply = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      const ratio = mobile ? 0.8 : 0.62;
      root.style.setProperty("--composer-sheet-max", `${Math.max(240, Math.round(height * ratio))}px`);
    };
    apply();
    window.visualViewport?.addEventListener("resize", apply);
    window.addEventListener("resize", apply);
    return () => {
      window.visualViewport?.removeEventListener("resize", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--composer-sheet-max");
    };
  }, [editorOpen]);

  useEffect(() => {
    if (editorOpen || (collapsible && expanded)) textareaRef.current?.focus();
  }, [editorOpen, collapsible, expanded]);

  const send = async (submit: boolean) => {
    if (busy || uncertain || blockedFiles || tooLong) return;
    if (text.trim().length === 0 && submit === false) return;
    if (await drafts.run(surfaceId, () => onSend(text, submit), true)) setEditorOpen(false);
  };

  const pressKey = async (key: CmuxKey, repeat: 1 | 2 = 1) => {
    if (busy || uncertain || blockedFiles) return;
    if (isDangerousKey(key) && (pendingKey?.key !== key || pendingKey.repeat !== repeat)) {
      setPendingKey({ key, repeat });
      return;
    }
    setPendingKey(null);
    await drafts.run(surfaceId, () => onKey(key, isDangerousKey(key), repeat), false);
  };

  const feedback = failure ? (
    <div className={`composer-hint${uncertain ? " danger-hint" : ""}`} role="status">
      {failure}
      {uncertain ? <div className="composer-recovery-actions">
        {textWritten ? <button type="button" disabled={busy} onClick={() => {
          void drafts.run(surfaceId, () => onSend("", true), true, true);
        }}>已核对，仅补发 Enter</button> : null}
        {!draft.keyUncertain ? <button type="button" disabled={busy} onClick={() => drafts.resolve(surfaceId, true)}>终端已接收，清除草稿</button> : null}
        <button type="button" disabled={busy} onClick={() => drafts.resolve(surfaceId, false)}>{draft.keyUncertain ? "已核对，继续操作" : "终端未接收，继续编辑"}</button>
      </div> : null}
    </div>
  ) : null;

  if (collapsible && !expanded) {
    const preview = text.trim().length > 0 ? text.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    return (
      <div className="composer composer-collapsed">
        {feedback}
        <button type="button" className="composer-expand" onClick={() => setExpanded(true)}>
          {preview
            ? `继续编辑：${preview}${text.trim().length > 40 ? "…" : ""}`
            : "点这里输入…"}
        </button>
      </div>
    );
  }

  return (
    <div ref={composerRef} className={`composer${editorOpen ? " composer-editor-open" : ""}`}>
      {feedback}
      {blockedFiles && <div className="composer-hint" role="status">附件上传完成后可发送；失败的附件可点击重试或移除。</div>}
      {tooLong && <div className="composer-hint danger-hint" role="alert">展开路径后的消息超过 20000 字符，请缩短后发送。</div>}
      <div className="composer-input-row">
        <div className="composer-input-wrap">
          <InlineEditor ref={textareaRef} nodes={nodes} disabled={busy || uncertain}
            onChange={value => drafts.editNodes(surfaceId, value)} onFiles={uploadFiles} onPaths={insertPaths}
            onReference={ref => setSelectedReference(ref.id)}
            onLongPaste={value => { if (shouldExpandEditorForText(value)) setEditorOpen(true); }}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); void send(true);
              }
              if (event.altKey && event.key === "ArrowUp" && agentKind === "codex" && !event.nativeEvent.isComposing) {
                // 浏览器里按 Option+↑ 直接落到 Codex 的排队消息 / 异步提问，省得去点键条。
                event.preventDefault();
                if (!event.repeat) void pressKey("alt+up");
              }
              if (event.key === "Escape" && editorOpen) { event.preventDefault(); setEditorOpen(false); }
            }}
          />
          <div className="composer-actions">
            <AttachmentControls surfaceId={surfaceId} disabled={busy || uncertain} onFiles={uploadFiles} onPaths={insertPaths} />
            <div className="composer-action-spacer" />
            <button
              type="button"
              className="composer-size-toggle"
              title={editorOpen ? "还原输入区" : "放大输入区"}
              aria-label={editorOpen ? "还原输入区" : "放大输入区"}
              aria-expanded={editorOpen}
              onClick={() => setEditorOpen((current) => !current)}
            >
              <SizeGlyph expanded={editorOpen} />
            </button>

          <button
            type="button"
            className="send-button"
            disabled={busy || uncertain || blockedFiles || tooLong || text.trim().length === 0}
            onClick={() => void send(true)}
          >
            <span>发送</span>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 12V4m-4 4 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          </div>
        </div>
      </div>

      <div className="composer-footer">
      <div
        className={`key-bar-wrap ${edges.start ? "fade-start" : ""} ${edges.end ? "fade-end" : ""}`}
      >
        <div className="key-bar" ref={keyBarRef} onScroll={syncEdges}>
          {keyGroupsForAgent(agentKind).map((group, groupIndex) => (
            <div className="key-group" key={group[0]?.key ?? groupIndex}>
              {group.map(({ key, label, title, repeat = 1 }) => (
                <button
                  type="button"
                  key={`${key}:${repeat}`}
                  title={title}
                  className={[
                    "key-button",
                    isDangerousKey(key) ? "danger" : "",
                    pendingKey?.key === key && pendingKey.repeat === repeat ? "danger-armed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={busy || uncertain || blockedFiles}
                  onClick={() => void pressKey(key, repeat)}
                >
                  {pendingKey?.key === key && pendingKey.repeat === repeat ? "确认?" : label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
            {collapsible ? (
              <button
                type="button"
                className="composer-collapse"
                onClick={() => {
                  setEditorOpen(false);
                  setExpanded(false);
                }}
                title="收起输入区，保留草稿"
                aria-label="收起输入区"
              >
                <span>收起</span>
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path
                    d="m4 6 4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
      </div>
      {reference && <ReferenceDetails reference={reference} disabled={busy || uncertain} onClose={() => setSelectedReference(null)}
        onRemove={() => { drafts.editNodes(surfaceId, nodes.filter(n => n.type !== "file" || n.id !== reference.id)); setSelectedReference(null); textareaRef.current?.focus(); }}
        onRetry={() => uploadReference(drafts, surfaceId, reference)} />}
      {pendingKey ? (
        <div className="composer-hint danger-hint">
          {pendingKey.repeat === 2 ? "连续发送两次 Ctrl+C，可能退出 Agent；未提交的终端输入可能丢失" : DANGEROUS_KEY_HINT[pendingKey.key] ?? "危险操作"}。再点一次「确认?」发送，或
          <button type="button" className="link-button" onClick={() => setPendingKey(null)}>
            取消
          </button>
        </div>
      ) : null}
    </div>
  );
}
