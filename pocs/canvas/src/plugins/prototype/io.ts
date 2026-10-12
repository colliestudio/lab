import type { CanvasNode, DocFilter } from '../../core';
import { DEVICES, FIELD, standIn } from './model';

// JSON Canvas import repair: a page needs string html, a known device width and a title; a note
// needs `note: true` (its `on` is dropped if that page isn't in the file). Anything else: the field goes.

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const repairImport: DocFilter = (doc) => {
  const ids = new Set(doc.nodes.map((n) => n.id));
  return {
    ...doc,
    nodes: doc.nodes.map((n): CanvasNode => {
      const f = n[FIELD];
      if (f === undefined) return n;
      const { [FIELD]: _drop, ...rest } = n;
      if (!obj(f)) return rest as CanvasNode;
      if (typeof f.html === 'string') {
        const title = typeof f.title === 'string' && f.title.trim() ? f.title.trim().slice(0, 80) : 'Untitled';
        const vw = DEVICES.find((d) => d.vw === f.vw)?.vw ?? DEVICES[0].vw;
        return { ...rest, type: 'text', text: typeof n.text === 'string' ? n.text : standIn(title), [FIELD]: { html: f.html, vw, title, ...(f.start === true ? { start: true } : {}) } } as CanvasNode;
      }
      if (f.note === true) return { ...rest, [FIELD]: typeof f.on === 'string' && ids.has(f.on) ? { note: true, on: f.on } : { note: true } } as CanvasNode;
      return rest as CanvasNode;
    }),
  };
};
