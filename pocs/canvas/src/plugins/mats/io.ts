import type { CanvasNode, DocFilter } from '../../core';
import { FIELD as CARDS } from '../cards/deck';
import { DEFAULT_MAT_COLOR, FIELD, MAT_MIN, type MatField, type ZoneField } from './model';

// JSON Canvas import repair for mats and zones. On export they are already `group` nodes with a
// label (a mat is one in the live doc too; the cards plugin exports every container as a group),
// so in Obsidian a mat is a group holding its zones, which hold their cards.

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export const repairImport: DocFilter = (doc) => {
  const mats = new Set(doc.nodes.filter((n) => obj(n[FIELD]) && (n[FIELD] as Record<string, unknown>).kind === 'mat').map((n) => n.id));
  return {
    ...doc,
    nodes: doc.nodes.map((n): CanvasNode => {
      const f = n[FIELD];
      if (f === undefined) return n;
      if (obj(f) && f.kind === 'mat') {
        const m: MatField = { kind: 'mat' };
        if (f.unlocked === true) m.unlocked = true;
        if (str(f.preset)) m.preset = str(f.preset);
        return {
          ...n,
          type: 'group',
          width: Math.max(MAT_MIN.w, n.width),
          height: Math.max(MAT_MIN.h, n.height),
          label: str(n.label) ?? 'Mat',
          color: typeof n.color === 'string' ? n.color : DEFAULT_MAT_COLOR,
          [FIELD]: m,
        };
      }
      // a zone: of a mat in this file; a container zone must be a cards container, a free one a group
      if (obj(f) && typeof f.zone === 'string' && mats.has(f.zone)) {
        const z: ZoneField = { zone: f.zone };
        if (str(f.name)) z.name = str(f.name);
        if (str(f.role)) z.role = str(f.role);
        if (f.free === true) return { ...n, type: 'group', label: z.name ?? str(n.label) ?? 'Area', [FIELD]: { ...z, free: true } };
        if (obj(n[CARDS]) && (n[CARDS] as Record<string, unknown>).deck === true) return { ...n, [FIELD]: z };
      }
      const { [FIELD]: _drop, ...rest } = n;
      console.warn(`mats: ignoring invalid ${FIELD} on node ${n.id}`);
      return rest as CanvasNode;
    }),
  };
};
