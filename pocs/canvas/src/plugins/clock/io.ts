import type { CanvasNode, DocFilter } from '../../core';
import { FIELD, clockText, isRot, isSide, type ClockField } from './model';

const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Import: keep a clock only if its numbers make sense; drop bad optional fields. */
export const repairImport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n): CanvasNode => {
    const f = n[FIELD] as Record<string, unknown> | undefined;
    if (f === undefined) return n;
    const day = 24 * 3600_000;
    if (!f || typeof f !== 'object' || f.kind !== 'clock' || !num(f.base, 1, day) || !num(f.inc, 0, 3600_000)) {
      const { [FIELD]: _drop, ...rest } = n;
      console.warn(`clock: ignoring invalid ${FIELD} on node ${n.id}`);
      return rest as CanvasNode;
    }
    const c: ClockField = {
      kind: 'clock',
      base: f.base as number,
      inc: f.inc as number,
      left0: num(f.left0, 0, day) ? (f.left0 as number) : (f.base as number),
      left1: num(f.left1, 0, day) ? (f.left1 as number) : num(f.base1, 1, day) ? (f.base1 as number) : (f.base as number),
    };
    if (num(f.base1, 1, day) && num(f.inc1, 0, 3600_000)) {
      c.base1 = f.base1 as number;
      c.inc1 = f.inc1 as number;
    }
    if (isRot(f.rot)) c.rot = f.rot;
    if (isSide(f.run)) c.run = f.run;
    if (c.run !== undefined && num(f.since, 0, Number.MAX_SAFE_INTEGER)) c.since = f.since as number;
    if (f.paused === true) c.paused = true;
    if (isSide(f.flag)) c.flag = f.flag;
    // a running clock without a start time can't be computed: treat it as paused
    if (c.run !== undefined && c.since === undefined && c.flag === undefined) c.paused = true;
    if (typeof f.name0 === 'string') c.name0 = f.name0;
    if (typeof f.name1 === 'string') c.name1 = f.name1;
    return { ...n, [FIELD]: c };
  }),
});

/** Export: readable text ("Game clock 5+0: White 4:12 / Black 5:00", as of the last switch). */
export const shapeExport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n) => ((n[FIELD] as ClockField | undefined)?.kind === 'clock' ? { ...n, text: clockText(n[FIELD] as ClockField) } : n)),
});
