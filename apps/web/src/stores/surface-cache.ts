import type { SurfaceGrid } from "@car/protocol";

/** 高频画面独立于应用 Context；只通知订阅该 surface 的组件。 */
export class SurfaceCache {
  private grids = new Map<string, SurfaceGrid>();
  private listeners = new Map<string, Set<() => void>>();

  get = (id: string): SurfaceGrid | undefined => this.grids.get(id);

  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  set(id: string, grid: SurfaceGrid): void {
    if (this.grids.get(id)?.revision === grid.revision) return;
    this.grids.set(id, grid);
    this.notify(id);
  }

  forget(id: string): void {
    if (this.grids.delete(id)) this.notify(id);
  }

  retain(ids: Set<string>): void {
    for (const id of this.grids.keys()) if (!ids.has(id)) this.forget(id);
  }

  clear(): void {
    const ids = [...this.grids.keys()];
    this.grids.clear();
    ids.forEach(id => this.notify(id));
  }

  private notify(id: string): void { this.listeners.get(id)?.forEach(listener => listener()); }
}
