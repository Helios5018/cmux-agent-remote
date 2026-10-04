export interface FileReference {
  type: "file";
  id: string;
  name: string;
  path?: string;
  size: number;
  status: "uploading" | "ready" | "error";
  progress?: number;
  error?: string;
  file?: File;
}
export type InputNode = { type: "text"; text: string } | FileReference;
export const nodesText = (nodes: InputNode[]) => nodes.map(n => n.type === "text" ? n.text : n.path ? JSON.stringify(n.path) : `[${n.name}：${n.status === "error" ? "上传失败" : "上传中"}]`).join("");
export const nodeLength = (n: InputNode) => n.type === "text" ? n.text.length : 1;
export const nodesLength = (nodes: InputNode[]) => nodes.reduce((total, n) => total + nodeLength(n), 0);
export function normalizeNodes(nodes: InputNode[]): InputNode[] {
  const result: InputNode[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      if (!n.text) continue;
      const last = result[result.length - 1];
      if (last?.type === "text") last.text += n.text;
      else result.push({ ...n });
    } else result.push(n);
  }
  return result;
}
export function sliceNodes(nodes: InputNode[], start: number, end = nodesLength(nodes)): InputNode[] {
  let offset = 0;
  return normalizeNodes(nodes.flatMap<InputNode>(n => {
    const from = offset; offset += nodeLength(n);
    if (offset <= start || from >= end) return [];
    return n.type === "text" ? [{ type: "text" as const, text: n.text.slice(Math.max(0, start - from), end - from) }] : [n];
  }));
}
export function replaceNodes(nodes: InputNode[], start: number, end: number, inserted: InputNode[]) {
  return normalizeNodes([...sliceNodes(nodes, 0, start), ...inserted, ...sliceNodes(nodes, end)]);
}
export function referenceForPath(path: string): FileReference {
  return { type: "file", id: crypto.randomUUID(), path, name: path.split("/").pop() || path, size: 0, status: "ready" };
}
