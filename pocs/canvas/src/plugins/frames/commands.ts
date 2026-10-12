import { isIds, isNum, pick, set, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { FRAME, PORTAL, TITLE_H, frameField, isFrame, isPortal, isRoomId, orderedFrames, portalRoom } from './model';

// Commands: plain data in, Changes out (agents can call them the same way the UI does).

export const MIN_W = 160;
export const MIN_H = 100;
const PAD = 40;

const lowestZ = (doc: DocView) => (doc.nodes.length ? Math.min(...doc.nodes.map((n) => n.z ?? 0)) : 0);
const cleanLabel = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 80) : undefined);

/** Bounding box of nodes (world). */
export function bounds(nodes: readonly Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>[]) {
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  return { x, y, width: Math.max(...nodes.map((n) => n.x + n.width)) - x, height: Math.max(...nodes.map((n) => n.y + n.height)) - y };
}

/** Write each frame's current place in the presentation as an explicit order (no change to the order itself). */
function pinOrder(doc: DocView): Change[] {
  return orderedFrames(doc).flatMap((n, i) => (frameField(n).order === i ? [] : [set(n.id, `${FRAME}.order`, i)]));
}

/**
 * Frames are backdrops, but pressing one raises it (and its contents) above everything, so a
 * dragged frame would end up covering unrelated notes. Put frames back under every other node,
 * keeping their order among themselves (nested frames stay inside-over-outside). No-op if they are.
 */
export const sink: Command<Record<string, never>> = (doc) => {
  const frames = doc.nodes.filter(isFrame).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const ids = new Set(frames.map((f) => f.id));
  const others = doc.nodes.filter((n) => !ids.has(n.id));
  if (!frames.length || !others.length) return [];
  const floor = Math.min(...others.map((n) => n.z ?? 0));
  if ((frames[frames.length - 1].z ?? 0) < floor) return [];
  return frames.map((f, i) => set(f.id, 'z', floor - (frames.length - i)));
};

/**
 * Slide order is reading order only until frames are touched: without an explicit order, moving a
 * frame across the canvas would reshuffle the talk. Pinning writes the order down (no-op once every
 * frame has one). Called before anything that can move a frame, and when presenting.
 */
export const pin: Command<Record<string, never>> = (doc) => pinOrder(doc);

/**
 * New frame, under everything (frames are backdrops). `around`: fit it around those nodes (with a
 * margin and room for the title); else a box at x, y (top-left) of width x height.
 */
export const create: Command<{ x?: number; y?: number; width?: number; height?: number; label?: string; around?: string[] }> = (doc, a, ctx) => {
  let box: { x: number; y: number; width: number; height: number } | undefined;
  const around = isIds(a?.around) ? pick(doc, a.around).filter((n) => doc.isVisible(n.id)) : [];
  if (around.length) {
    const b = bounds(around);
    box = { x: b.x - PAD, y: b.y - PAD - TITLE_H, width: b.width + 2 * PAD, height: b.height + 2 * PAD + TITLE_H };
  } else if (isNum(a?.x) && isNum(a?.y)) {
    box = { x: a.x, y: a.y, width: isNum(a.width) ? a.width : 640, height: isNum(a.height) ? a.height : 420 };
  }
  if (!box) return [];
  const id = ctx.newId();
  const frames = doc.nodes.filter(isFrame);
  // a new frame goes last; the existing ones get their current order written down so it stays put
  const pinned = pinOrder(doc);
  const node: CanvasNode = {
    id,
    type: 'group',
    label: cleanLabel(a?.label) || `Frame ${frames.length + 1}`,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(MIN_W, Math.round(box.width)),
    height: Math.max(MIN_H, Math.round(box.height)),
    z: lowestZ(doc) - 1,
    [FRAME]: { order: frames.length },
  };
  return { changes: [...pinned, { op: 'add', node }], select: [id], events: [{ type: 'frames.create', text: `added frame “${node.label}”`, targets: [id] }] };
};

export const rename: Command<{ id: string; label: string }> = (doc, a) => {
  const f = doc.get(a?.id);
  const label = cleanLabel(a?.label);
  if (!isFrame(f) && !isPortal(f)) return [];
  if (!label || label === f!.label) return [];
  return [set(f!.id, 'label', label)];
};

export const resize: Command<{ id: string; width: number; height: number }> = (doc, a) => {
  const f = doc.get(a?.id);
  if (!(isFrame(f) || isPortal(f)) || !isNum(a.width) || !isNum(a.height)) return [];
  const w = Math.max(MIN_W, Math.round(a.width));
  const h = Math.max(MIN_H, Math.round(a.height));
  const out: Change[] = [];
  if (w !== f!.width) out.push(set(f!.id, 'width', w));
  if (h !== f!.height) out.push(set(f!.id, 'height', h));
  return out;
};

/** Move a frame to position `to` (0-based) in the presentation order; every frame gets an explicit order. */
export const reorder: Command<{ id: string; to: number }> = (doc, a) => {
  const list = orderedFrames(doc);
  const from = list.findIndex((f) => f.id === a?.id);
  if (from < 0 || !isNum(a.to)) return [];
  const to = Math.max(0, Math.min(list.length - 1, Math.round(a.to)));
  const [f] = list.splice(from, 1);
  list.splice(to, 0, f);
  return list.flatMap((n, i) => (frameField(n).order === i ? [] : [set(n.id, `${FRAME}.order`, i)]));
};

/** Leave a frame out of (or put it back in) the presentation. */
export const skip: Command<{ id: string; skip: boolean }> = (doc, a) => {
  const f = doc.get(a?.id);
  if (!isFrame(f)) return [];
  const want = !!a.skip;
  if (!!frameField(f).skip === want) return [];
  return [set(f.id, `${FRAME}.skip`, want ? true : undefined)];
};

/** Remove a frame but keep what is in it (Delete removes the contents too, like a board's pieces). */
export const unframe: Command<{ id: string }> = (doc, a) => (isFrame(doc.get(a?.id)) ? [{ op: 'del', id: a.id }] : []);

/** A portal into room `room`, centred on x, y. Stored as a JSON Canvas file node `<room>.canvas`. */
export const createPortal: Command<{ x: number; y: number; room: string; label?: string; width?: number; height?: number }> = (doc, a, ctx) => {
  if (!isNum(a?.x) || !isNum(a?.y) || !isRoomId(a?.room)) return [];
  const width = isNum(a.width) ? Math.max(MIN_W, a.width) : 560;
  const height = isNum(a.height) ? Math.max(MIN_H, a.height) : 440;
  const id = ctx.newId();
  const node: CanvasNode = {
    id,
    type: 'file',
    file: `${a.room}.canvas`,
    label: cleanLabel(a.label) || undefined,
    x: Math.round(a.x - width / 2),
    y: Math.round(a.y - height / 2),
    width,
    height,
    z: doc.topZ + 1,
    [PORTAL]: { room: a.room },
  };
  if (node.label === undefined) delete node.label;
  return { changes: [{ op: 'add', node }], select: [id], events: [{ type: 'frames.portal', text: `added a portal to ${a.room}`, targets: [id] }] };
};

/** Point a portal at another room. */
export const retarget: Command<{ id: string; room: string }> = (doc, a) => {
  const p = doc.get(a?.id);
  if (!isPortal(p) || !isRoomId(a.room) || portalRoom(p) === a.room) return [];
  return [set(p.id, 'file', `${a.room}.canvas`), set(p.id, PORTAL, { room: a.room })];
};

export const commands = { create, pin, sink, rename, resize, reorder, skip, unframe, createPortal, retarget };
