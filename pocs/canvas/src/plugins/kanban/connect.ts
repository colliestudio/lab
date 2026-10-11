import type { App } from '../../core';
import { BoardHost } from './host';
import { board, isBoard } from './model';
import type { LocalState } from './render';
import { DevFolder, FilesSource, FsaFolder, ServiceSource, type Source } from './sources';

// Which tab hosts which board, kept by this tab only. A board records its host tab in the doc
// (`ownerTab`); the tab keeps how it connected (localStorage) and the folder handle (IndexedDB), so
// a reload resumes hosting (a picked folder may need one click to grant access again).

type Kind = 'fsa' | 'dev' | 'service';

const TAB_KEY = 'canvas-kanban:tab';
export const tabId: string = (() => {
  try {
    let t = sessionStorage.getItem(TAB_KEY);
    if (!t) sessionStorage.setItem(TAB_KEY, (t = Math.random().toString(36).slice(2, 10)));
    return t;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
})();

const hosts = new Map<string, BoardHost>();
const pendingFsa = new Map<string, FileSystemDirectoryHandle>();
let devFolder: DevFolder | null | undefined;
let devProbe: Promise<DevFolder | null> | undefined;

export const canPick = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export function localState(boardId: string): LocalState {
  const h = hosts.get(boardId);
  return { hosting: !!h && !h.stopped, needsResume: pendingFsa.has(boardId), error: h?.error, canPick: canPick(), devFolder: devFolder?.name };
}

export function hostOf(boardId: string) {
  return hosts.get(boardId);
}

// ------------------------------------------------------------------ handle storage (IndexedDB)

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('canvas-kanban', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveHandle(boardId: string, h: FileSystemDirectoryHandle) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(h, boardId);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function loadHandle(boardId: string): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await idb();
  return new Promise((res) => {
    const r = db.transaction('handles').objectStore('handles').get(boardId);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}

// ------------------------------------------------------------------ connecting

function start(app: App, boardId: string, source: Source, kind: Kind) {
  hosts.get(boardId)?.stop();
  pendingFsa.delete(boardId);
  localStorage.setItem(`canvas-kanban:conn:${boardId}`, kind);
  const me = app.me();
  app.dispatch('kanban.connect', { id: boardId, source: source.kind, label: source.label, owner: me.id, ownerName: me.name, ownerTab: tabId }, { undoable: false });
  const host = new BoardHost(app.store, boardId, source).start();
  hosts.set(boardId, host);
  // the first cycle fills the board; redraw the header when it's done (errors show there)
  host.cycle().then(() => app.view.render());
  app.view.render();
  return host;
}

/** Ask for a folder (needs a click) and host the board from it. */
export async function pickFolder(app: App, boardId: string) {
  try {
    const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'canvas-kanban', mode: 'readwrite' });
    await saveHandle(boardId, handle);
    start(app, boardId, new FilesSource(new FsaFolder(handle)), 'fsa');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') app.notify(`Folder: ${(e as Error).message}`);
  }
}

export async function useDevFolder(app: App, boardId: string) {
  const f = await probeDev();
  if (!f) return app.notify('The dev server has no folder (start it with KANBAN_ROOT=…)');
  start(app, boardId, new FilesSource(f), 'dev');
}

export function useService(app: App, boardId: string) {
  start(app, boardId, new ServiceSource('/backlog-api'), 'service');
}

/** The click that grants folder access again after a reload. */
export async function resumeFolder(app: App, boardId: string) {
  const h = pendingFsa.get(boardId);
  if (!h) return;
  const ok = (await (h as any).requestPermission({ mode: 'readwrite' })) === 'granted';
  if (ok) start(app, boardId, new FilesSource(new FsaFolder(h)), 'fsa');
}

export function disconnect(app: App, boardId: string) {
  hosts.get(boardId)?.stop();
  hosts.delete(boardId);
  pendingFsa.delete(boardId);
  localStorage.removeItem(`canvas-kanban:conn:${boardId}`);
  app.view.render();
}

function probeDev() {
  devProbe ??= DevFolder.probe().then((f) => (devFolder = f));
  return devProbe;
}

/** After load / a sync: resume hosting the boards this tab hosted; drop hosts of deleted boards. */
export async function resume(app: App) {
  await probeDev();
  for (const [id, h] of hosts) {
    const b = app.node(id);
    // deleted, or another tab took over
    if (!isBoard(b) || board(b).ownerTab !== tabId) {
      h.stop();
      hosts.delete(id);
    }
  }
  for (const b of app.doc.nodes) {
    if (!isBoard(b) || board(b).ownerTab !== tabId || hosts.has(b.id) || pendingFsa.has(b.id)) continue;
    const kind = localStorage.getItem(`canvas-kanban:conn:${b.id}`) as Kind | null;
    if (kind === 'dev' && devFolder) start(app, b.id, new FilesSource(devFolder), 'dev');
    else if (kind === 'service') start(app, b.id, new ServiceSource('/backlog-api'), 'service');
    else if (kind === 'fsa') {
      const h = await loadHandle(b.id).catch(() => undefined);
      if (!h) continue;
      if ((await (h as any).queryPermission({ mode: 'readwrite' })) === 'granted') start(app, b.id, new FilesSource(new FsaFolder(h)), 'fsa');
      else pendingFsa.set(b.id, h);
    }
  }
  app.view.render();
}
