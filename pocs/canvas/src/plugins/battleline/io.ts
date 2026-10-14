import type { CanvasNode, DocFilter } from '../../core';
import { FIELD, FLAG_H, FLAG_W, ROLES, flagText, type FlagField, type PartField } from './model';

// JSON Canvas import repair and export text for Battle Line nodes. (Cards are the cards plugin's.)

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const repairImport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n): CanvasNode => {
    const f = n[FIELD];
    if (f === undefined) return n;
    if (obj(f) && f.kind === 'flag' && num(f.n) && f.n >= 1 && f.n <= 99) {
      const g: FlagField = { kind: 'flag', n: Math.floor(f.n), hx: num(f.hx) ? f.hx : n.x, hy: num(f.hy) ? f.hy : n.y };
      if (f.claim === 'a' || f.claim === 'b') g.claim = f.claim;
      return { ...n, width: FLAG_W, height: FLAG_H, text: flagText(g), [FIELD]: g };
    }
    // a tactic laid on a flag: who played it
    if (obj(f) && (f.by === 'a' || f.by === 'b') && f.role === undefined) return { ...n, [FIELD]: { by: f.by } };
    if (obj(f) && typeof f.role === 'string' && (ROLES as string[]).includes(f.role)) {
      const p: PartField = { role: f.role as PartField['role'] };
      if (num(f.flag)) p.flag = f.flag;
      if (f.side === 'a' || f.side === 'b') p.side = f.side;
      return { ...n, [FIELD]: p };
    }
    const { [FIELD]: _drop, ...rest } = n;
    console.warn(`battleline: ignoring invalid ${FIELD} on node ${n.id}`);
    return rest as CanvasNode;
  }),
});

/** Export: a flag reads "Flag 3" / "Flag 3 (claimed by A)" in Obsidian. */
export const shapeExport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    const f = n[FIELD] as FlagField | undefined;
    return f?.kind === 'flag' ? { ...n, text: flagText(f) } : n;
  }),
});
