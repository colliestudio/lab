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
