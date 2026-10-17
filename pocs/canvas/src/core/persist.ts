import { IndexeddbPersistence } from 'y-indexeddb';
import type { App } from './app';

/**
 * Local persistence: the Y.Doc is stored in IndexedDB (every update, no debounce).
 * Resolves once stored state is loaded; `empty` = nothing was stored.
 */
export async function persistLocally(app: App, name: string): Promise<{ empty: boolean }> {
  const p = new IndexeddbPersistence(name, app.store.ydoc);
  await p.whenSynced;
  app.store.migrate();
  app.store.undoManager.clear();
  // a background alone is something worth keeping
  return { empty: app.store.nodes.size === 0 && app.store.meta.size === 0 };
}

/** Viewport is per-device view state, not document state: plain localStorage. */
export function persistViewport(app: App, key: string): { x: number; y: number; zoom: number } | null {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    /* ignore */
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  app.viewport.onChange(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      const { x, y, zoom } = app.viewport;
      localStorage.setItem(key, JSON.stringify({ x, y, zoom }));
    }, 200);
  });
  return saved && [saved.x, saved.y, saved.zoom].every(Number.isFinite) ? saved : null;
}
