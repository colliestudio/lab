import type { App } from './app';
import { parse, serialize } from './io';
import type { CanvasDoc } from './doc';

// Save/open .canvas files. Uses the File System Access API when the page is a secure context
// (localhost, https); falls back to download + file input otherwise (e.g. plain http on a LAN name).

const TYPES = [{ description: 'JSON Canvas', accept: { 'application/json': ['.canvas'] } }];
let handle: any = null;

export async function saveFile(doc: CanvasDoc, opts: { saveAs?: boolean; name?: string } = {}): Promise<string | null> {
  const text = serialize(doc);
  const w = window as any;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      if (!handle || opts.saveAs) handle = await w.showSaveFilePicker({ suggestedName: opts.name ?? 'table.canvas', types: TYPES });
      const ws = await handle.createWritable();
      await ws.write(text);
      await ws.close();
      return handle.name as string;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      throw e;
    }
  }
  const name = opts.name ?? 'table.canvas';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}

export async function openFile(): Promise<{ name: string; doc: CanvasDoc } | null> {
  const w = window as any;
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [h] = await w.showOpenFilePicker({ types: TYPES });
      const file: File = await h.getFile();
      const doc = parse(await file.text());
      handle = h;
      return { name: file.name, doc };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      throw e;
    }
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.canvas,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  if (!file) return null;
  handle = null;
  return { name: file.name, doc: parse(await file.text()) };
}

/** Forget the current file handle (next save asks where). */
export function resetFileHandle() {
  handle = null;
}

/** Persist doc + viewport to localStorage, debounced. Returns the saved state if any. */
export function autosave(app: App, key: string): { doc: CanvasDoc; view?: { x: number; y: number; zoom: number } } | null {
  let saved = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { canvas, view } = JSON.parse(raw);
      saved = { doc: parse(JSON.stringify(canvas)), view };
    }
  } catch (e) {
    console.warn('autosave unreadable, starting fresh', e);
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const { x, y, zoom } = app.viewport;
      localStorage.setItem(key, JSON.stringify({ canvas: app.store.doc, view: { x, y, zoom } }));
    }, 300);
  };
  app.store.subscribe(write);
  app.viewport.onChange(write);
  return saved;
}
