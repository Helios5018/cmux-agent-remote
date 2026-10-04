import { useSyncExternalStore } from "react";
export interface BrowserTab { id: string; path: string; scroll: number; selected: string[]; query: string; mode: string; hidden: boolean; loaded: number }
export interface BrowserState { tabs: BrowserTab[]; active: string; clipboard: string[]; clipboardMode?: "copy" | "move" }
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const emptyState = (): BrowserState => ({ tabs: [], active: "", clipboard: [] });
function localStorageOrNull(): Storage | null { try { return window.localStorage; } catch { return null; } }

/** Each owner has its own store. Closing retires it so late requests cannot revive cleared tabs. */
export class FileBrowserStore {
  private state: BrowserState = emptyState();
  private retired = false;
  private listeners = new Set<() => void>();
  private readonly key: string;
  constructor(owner: string, private readonly storage: Storage | null = localStorageOrNull()) {
    this.key = `car.files.v3.${encodeURIComponent(owner)}`;
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? "null");
      if (saved && Array.isArray(saved.tabs) && saved.tabs.every((t: BrowserTab) => typeof t.id === "string" && typeof t.path === "string" && Array.isArray(t.selected) && typeof t.query === "string") && saved.tabs.some((t: BrowserTab) => t.id === saved.active)) {
        this.state = { ...saved, tabs: saved.tabs.map((t: BrowserTab) => ({ ...t, hidden: t.hidden ?? true })), clipboard: Array.isArray(saved.clipboard) ? saved.clipboard : [] };
      }
    } catch { /* Unavailable or obsolete data starts fresh. Shared v1/v2 state is not inherited. */ }
  }
  getFiles = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setFiles = (next: BrowserState) => {
    if (this.retired) return;
    this.state = next;
    try { this.storage?.setItem(this.key, JSON.stringify(next)); } catch { /* Memory still works. */ }
    this.listeners.forEach((listener) => listener());
  };
  patchTab = (id: string, patch: Partial<BrowserTab>) => {
    this.setFiles({ ...this.state, tabs: this.state.tabs.map((t) => t.id === id ? { ...t, ...patch } : t) });
  };
  addTab = (path: string) => {
    const id = crypto.randomUUID();
    this.setFiles({ ...this.state, active: id, tabs: [...this.state.tabs, { id, path, scroll: 0, selected: [], query: "", mode: "filter", hidden: true, loaded: 100 }] });
  };
  close = () => {
    this.retired = true; this.state = emptyState();
    try { this.storage?.removeItem(this.key); } catch { /* Storage may be unavailable. */ }
    this.listeners.forEach((listener) => listener());
  };
}
const stores = new Map<string, FileBrowserStore>();
export function getFileStore(owner: string) {
  let store = stores.get(owner);
  if (!store) { store = new FileBrowserStore(owner); stores.set(owner, store); }
  return store;
}
export function resetFiles(owner: string) { getFileStore(owner).close(); stores.delete(owner); }
export function useFiles(owner: string) {
  const store = getFileStore(owner);
  const state = useSyncExternalStore(store.subscribe, store.getFiles);
  return { state, getFiles: store.getFiles, setFiles: store.setFiles, patchTab: store.patchTab, addTab: store.addTab };
}
export function isFilesOpen(id: string) { try { return localStorage.getItem(`car.files.open.${id}`) === "1"; } catch { return false; } }
export function saveFilesOpen(id: string, open: boolean) { try { localStorage.setItem(`car.files.open.${id}`, open ? "1" : "0"); } catch { /* unavailable storage */ } }
