import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileIcon, fileStyle } from "../files/FileEntryContent.tsx";
import { normalizeNodes, nodesLength, nodesText, replaceNodes, sliceNodes, type FileReference, type InputNode } from "./model.ts";

export interface InlineEditorHandle {
  focus(): void;
  insert(nodes: InputNode[]): void;
  element(): HTMLDivElement | null;
}

/** Native DOM owns the editable subtree; React only updates it for external changes. */
export const InlineEditor = forwardRef<InlineEditorHandle, {
  nodes: InputNode[];
  disabled: boolean;
  onChange(nodes: InputNode[]): void;
  onFiles(files: File[]): void;
  onPaths(paths: string[]): void;
  onReference(ref: FileReference): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onLongPaste(text: string): void;
}>(({ nodes, disabled, onChange, onFiles, onPaths, onReference, onKeyDown, onLongPaste }, forwardedRef) => {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(nodes); current.current = nodes;
  const painted = useRef<InputNode[] | null>(null);
  const cursor = useRef({ start: 0, end: 0 });
  const composing = useRef(false);
  const history = useRef<{ nodes: InputNode[]; cursor: typeof cursor.current }[]>([]);
  const future = useRef<typeof history.current>([]);

  const read = (container: Node): InputNode[] => {
    const known = new Map(current.current.filter((n): n is FileReference => n.type === "file").map(n => [n.id, n]));
    const walk = (parent: Node): InputNode[] => {
      const result: InputNode[] = [];
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) result.push({ type: "text", text: child.textContent ?? "" });
        else if (child instanceof HTMLElement) {
          if (child.dataset.fileRef) { const ref = known.get(child.dataset.fileRef); if (ref) result.push(ref); }
          else if (child.tagName === "BR") { if (!child.dataset.trailing) result.push({ type: "text", text: "\n" }); }
          else {
            if (["DIV", "P"].includes(child.tagName) && result.length) result.push({ type: "text", text: "\n" });
            result.push(...walk(child));
          }
        }
      }
      return normalizeNodes(result);
    };
    return walk(container);
  };
  const remember = () => {
    const el = root.current; const selection = window.getSelection();
    if (!el || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return;
    const prefix = document.createRange(); prefix.selectNodeContents(el); prefix.setEnd(range.startContainer, range.startOffset);
    const start = nodesLength(read(prefix.cloneContents()));
    cursor.current = { start, end: start + nodesLength(read(range.cloneContents())) };
  };
  const restore = () => {
    const el = root.current; if (!el) return;
    const point = (offset: number): [Node, number] => {
      let remaining = offset;
      for (let i = 0; i < el.childNodes.length; i++) {
        const child = el.childNodes[i]!;
        const length = child.nodeType === Node.TEXT_NODE ? child.textContent?.length ?? 0 : child instanceof HTMLElement && child.dataset.fileRef ? 1 : 0;
        if (remaining <= length && child.nodeType === Node.TEXT_NODE) return [child, remaining];
        if (remaining === 0) return [el, i];
        remaining -= length;
      }
      return [el, el.childNodes.length];
    };
    const range = document.createRange(); range.setStart(...point(cursor.current.start)); range.setEnd(...point(cursor.current.end));
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  };
  const paint = (value: InputNode[]) => {
    const el = root.current; if (!el) return;
    el.replaceChildren();
    for (const node of value) {
      if (node.type === "text") { el.append(document.createTextNode(node.text)); continue; }
      const chip = document.createElement("span");
      chip.contentEditable = "false"; chip.dataset.fileRef = node.id;
      chip.className = `inline-file inline-file-${node.status}`;
      chip.setAttribute("role", "button"); chip.tabIndex = 0;
      chip.title = node.path ?? node.error ?? "正在上传";
      chip.innerHTML = renderToStaticMarkup(<FileIcon style={fileStyle({ name: node.name, kind: "file" })} />);
      const label = document.createElement("span"); label.className = "inline-file-name"; label.textContent = node.name;
      chip.append(label);
      if (node.status !== "ready") {
        const status = document.createElement("small"); status.textContent = node.status === "error" ? "失败 · 重试" : `${node.progress ?? 0}%`; chip.append(status);
      }
      el.append(chip);
    }
    // A trailing BR makes a final newline visible without becoming part of the message.
    const tail = document.createElement("br"); tail.dataset.trailing = "true"; el.append(tail);
    el.dataset.empty = String(value.length === 0);
    painted.current = value;
  };
  const commit = (next: InputNode[], native = false) => {
    history.current.push({ nodes: current.current, cursor: { ...cursor.current } });
    if (history.current.length > 100) history.current.shift();
    future.current = [];
    if (native) painted.current = next;
    if (root.current) root.current.dataset.empty = String(next.length === 0);
    current.current = next;
    onChange(next);
  };
  const insert = (inserted: InputNode[]) => {
    if (disabled) return;
    remember();
    const { start, end } = cursor.current;
    const next = replaceNodes(current.current, start, end, inserted);
    commit(next);
    cursor.current = { start: start + nodesLength(inserted), end: start + nodesLength(inserted) };
    paint(next); root.current?.focus(); restore();
  };
  const undo = (redo: boolean) => {
    const source = redo ? future.current : history.current; const target = redo ? history.current : future.current;
    const state = source.pop(); if (!state) return;
    target.push({ nodes: current.current, cursor: { ...cursor.current } });
    // Upload progress is external: don't resurrect stale uploading nodes on undo.
    const latest = new Map(current.current.filter((n): n is FileReference => n.type === "file").map(n => [n.id, n]));
    const next = state.nodes.map(n => n.type === "file" ? latest.get(n.id) ?? (n.status === "uploading" ? { ...n, status: "error" as const, error: "引用已移除，请重试上传" } : n) : n);
    current.current = next; cursor.current = state.cursor; onChange(next); paint(next); restore();
  };
  useImperativeHandle(forwardedRef, () => ({ focus: () => root.current?.focus(), insert, element: () => root.current }));
  useLayoutEffect(() => {
    if (painted.current === nodes || composing.current) return;
    const focused = root.current === document.activeElement;
    if (focused) remember();
    const latest = new Map(nodes.filter((n): n is FileReference => n.type === "file").map(n => [n.id, n]));
    for (const stack of [history.current, future.current]) {
      for (const state of stack) state.nodes = state.nodes.map(n => n.type === "file" ? latest.get(n.id) ?? n : n);
    }
    paint(nodes); if (focused) restore();
    if (!nodes.length) { history.current = []; future.current = []; cursor.current = { start: 0, end: 0 }; }
  }, [nodes]);

  return <div ref={root} className="composer-input inline-editor" role="textbox" aria-label="输入消息" aria-multiline="true" aria-disabled={disabled}
    contentEditable={!disabled} suppressContentEditableWarning data-placeholder="输入消息……" tabIndex={0}
    onInput={() => {
      if (!root.current) return;
      const next = read(root.current);
      // IME mutates the DOM before committing the draft; hide the placeholder immediately.
      root.current.dataset.empty = String(next.length === 0);
      if (composing.current) return;
      commit(next, true); remember();
    }}
    onCompositionStart={() => { composing.current = true; if (root.current) root.current.dataset.empty = "false"; }}
    onCompositionEnd={() => { composing.current = false; if (root.current) { commit(read(root.current), true); remember(); } }}
    onBlur={remember} onKeyUp={remember} onMouseUp={remember} onTouchEnd={remember}
    onClick={event => { const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-file-ref]"); const ref = current.current.find(n => n.type === "file" && n.id === chip?.dataset.fileRef); if (ref?.type === "file") onReference(ref); }}
    onBeforeInput={event => {
      const input = event.nativeEvent as InputEvent;
      if (input.inputType === "historyUndo" || input.inputType === "historyRedo") { event.preventDefault(); if (!disabled) undo(input.inputType === "historyRedo"); }
    }}
    onKeyDown={event => {
      if (disabled || composing.current || event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === "y"); return; }
      const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-file-ref]");
      if (chip && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); const ref = current.current.find(n => n.type === "file" && n.id === chip.dataset.fileRef); if (ref?.type === "file") onReference(ref); return; }
      onKeyDown(event); if (event.defaultPrevented) return;
      if (event.key === "Enter") { event.preventDefault(); insert([{ type: "text", text: "\n" }]); }
      if (event.key === "Backspace" || event.key === "Delete") {
        remember(); const { start, end } = cursor.current;
        const from = event.key === "Backspace" ? start - 1 : start;
        if (start === end && sliceNodes(current.current, from, from + 1)[0]?.type === "file") {
          event.preventDefault(); cursor.current = { start: Math.max(0, from), end: from + 1 };
          const next = replaceNodes(current.current, cursor.current.start, cursor.current.end, []); commit(next);
          cursor.current.end = cursor.current.start; paint(next); restore();
        }
      }
    }}
    onPaste={event => {
      event.preventDefault(); if (disabled) return; remember();
      const files = [...event.clipboardData.files];
      if (files.length) { onFiles(files); return; }
      const text = event.clipboardData.getData("text/plain"); insert([{ type: "text", text }]); onLongPaste(nodesText(current.current));
    }}
    onCopy={event => { remember(); event.clipboardData.setData("text/plain", nodesText(sliceNodes(current.current, cursor.current.start, cursor.current.end))); event.preventDefault(); }}
    onCut={event => { if (disabled) { event.preventDefault(); return; } remember(); event.clipboardData.setData("text/plain", nodesText(sliceNodes(current.current, cursor.current.start, cursor.current.end))); event.preventDefault(); insert([]); }}
    onDragOver={event => { if (!disabled) event.preventDefault(); }}
    onDrop={event => {
      event.preventDefault(); if (disabled) return;
      const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
      let range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!range) { const point = doc.caretPositionFromPoint?.(event.clientX, event.clientY); if (point) { range = document.createRange(); range.setStart(point.offsetNode, point.offset); range.collapse(true); } }
      if (range && root.current?.contains(range.startContainer)) { window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); remember(); }
      const paths = event.dataTransfer.getData("application/x-car-files");
      if (paths) { try { const value = JSON.parse(paths); if (Array.isArray(value) && value.every(p => typeof p === "string" && p.startsWith("/"))) onPaths(value); } catch { /* Ignore malformed external drag. */ } }
      else if (event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
      else insert([{ type: "text", text: event.dataTransfer.getData("text/plain") }]);
    }}
  />;
});
