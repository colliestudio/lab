import type { CanvasNode, DocView } from '../../core';

// Frames and portals: navigation and structure for big canvases. Both are standard JSON Canvas
// nodes, so a file opened in Obsidian (or saved from it) keeps its meaning:
// - a frame is a `group` node (label = title). `x-frame` holds what JSON Canvas has no field for:
//   `order` (slide position) and `skip` (left out of the presentation). A plain group with no
//   plugin fields at all (an Obsidian group) is a frame too.
// - a portal is a `file` node pointing at another canvas ("sprint-12.canvas", as Obsidian Advanced
//   Canvas portals do). `x-portal.room` names the live room it shows; without it the room is the
//   file's base name.
// Membership is geometric (like JSON Canvas groups): a node whose center lies inside a frame (the
// smallest one, if they nest) rides on it: it moves with the frame and comes to front with it.

export const FRAME = 'x-frame';
export const PORTAL = 'x-portal';
/** Height of a frame's title bar (world px). */
export const TITLE_H = 36;

export interface FrameField {
  order?: number;
  /** Left out of the presentation (still listed in the outline). */
  skip?: boolean;
}
export interface PortalField {
  room?: string;
}

const hasExt = (n: CanvasNode) => Object.keys(n).some((k) => k.startsWith('x-'));

export const isFrame = (n: CanvasNode | undefined): n is CanvasNode =>
  !!n && n.type === 'group' && (n[FRAME] !== undefined || !hasExt(n));
export const frameField = (n: CanvasNode): FrameField => (n[FRAME] as FrameField | undefined) ?? {};

export const isPortal = (n: CanvasNode | undefined): n is CanvasNode => !!n && n.type === 'file' && (n[PORTAL] !== undefined || /\.canvas$/i.test(n.file ?? ''));

/** Room ids are short and URL-safe. */
export const isRoomId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v);

/** The live room a portal shows, if it names a valid one. */
export function portalRoom(n: CanvasNode): string | undefined {
  const explicit = (n[PORTAL] as PortalField | undefined)?.room;
  if (explicit !== undefined) return isRoomId(explicit) ? explicit : undefined;
  const base = (n.file ?? '').split('/').pop()?.replace(/\.canvas$/i, '').toLowerCase();
  return isRoomId(base) ? base : undefined;
}

export const portalTitle = (n: CanvasNode) => n.label || portalRoom(n) || n.file || 'portal';

export const frameTitle = (n: CanvasNode, i?: number) => n.label?.trim() || (i === undefined ? 'Frame' : `Frame ${i + 1}`);

const center = (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
const inside = (p: { x: number; y: number }, f: CanvasNode) => p.x > f.x && p.x < f.x + f.width && p.y > f.y && p.y < f.y + f.height;
const area = (n: CanvasNode) => n.width * n.height;

/** Frames among `nodes`, smallest first (the first that holds a point is the innermost). */
const framesCache = new WeakMap<readonly CanvasNode[], CanvasNode[]>();
function framesBySize(nodes: readonly CanvasNode[]): CanvasNode[] {
  let f = framesCache.get(nodes);
  if (!f) framesCache.set(nodes, (f = nodes.filter(isFrame).sort((a, b) => area(a) - area(b))));
  return f;
}

/** The frame `node` lies in by geometry: the smallest frame (bigger than the node) holding its center. */
export function frameAt(node: CanvasNode, nodes: readonly CanvasNode[]): string | undefined {
  const c = center(node);
  const a = area(node);
  for (const f of framesBySize(nodes)) if (f.id !== node.id && area(f) > a && inside(c, f)) return f.id;
  return undefined;
}

/** Membership of every node (node id → frame id), by geometry. */
export function memberships(nodes: readonly CanvasNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes) {
    const f = frameAt(n, nodes);
    if (f) out.set(n.id, f);
  }
  return out;
}

/**
 * Frames in presentation order: an explicit `order` first (ascending), then the rest in reading
 * order (rows top to bottom, left to right within a row). Stable for equal keys (by id).
 */
export function orderedFrames(doc: Pick<DocView, 'nodes'>): CanvasNode[] {
  const frames = doc.nodes.filter(isFrame);
  const row = (n: CanvasNode) => Math.round(n.y / 200);
  return frames.sort((a, b) => {
    const oa = frameField(a).order;
    const ob = frameField(b).order;
    if (oa !== undefined || ob !== undefined) {
      if (oa === undefined) return 1;
      if (ob === undefined) return -1;
      if (oa !== ob) return oa - ob;
    }
    return row(a) - row(b) || a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1);
  });
}

/** Frames that are slides (not skipped), in order. */
export const slides = (doc: Pick<DocView, 'nodes'>) => orderedFrames(doc).filter((f) => !frameField(f).skip);

export interface OutlineEntry {
  id: string;
  kind: 'frame' | 'portal';
  title: string;
  /** Nesting depth (a frame in a frame = 1). */
  depth: number;
  rect: { x: number; y: number; width: number; height: number };
  /** Frames: position in the presentation (1-based), undefined if skipped. Portals: undefined. */
  slide?: number;
  /** Portals: the room they show. */
  room?: string;
  /** Frames: how many nodes ride in it (directly). */
  count?: number;
}

/**
 * What a reader (person or agent) needs to navigate the canvas: frames in order, each followed by
 * the portals inside it; then portals outside any frame. Pure: works on any DocView.
 */
export function outline(doc: Pick<DocView, 'nodes'>, opts: { portals?: boolean } = {}): OutlineEntry[] {
  const nodes = doc.nodes;
  const member = memberships(nodes);
  const depthOf = (id: string) => {
    let d = 0;
    for (let f = member.get(id); f && d < 20; f = member.get(f)) d++;
    return d;
  };
  const counts = new Map<string, number>();
  for (const f of member.values()) counts.set(f, (counts.get(f) ?? 0) + 1);
  const rect = (n: CanvasNode) => ({ x: n.x, y: n.y, width: n.width, height: n.height });
  const portals = opts.portals === false ? [] : nodes.filter(isPortal);
  const out: OutlineEntry[] = [];
  let slide = 0;
  const placed = new Set<string>();
  for (const [i, f] of orderedFrames(doc).entries()) {
    const skip = !!frameField(f).skip;
    out.push({ id: f.id, kind: 'frame', title: frameTitle(f, i), depth: depthOf(f.id), rect: rect(f), slide: skip ? undefined : ++slide, count: counts.get(f.id) ?? 0 });
    for (const p of portals) {
      if (member.get(p.id) !== f.id) continue;
      placed.add(p.id);
      out.push({ id: p.id, kind: 'portal', title: portalTitle(p), depth: depthOf(p.id), rect: rect(p), room: portalRoom(p) });
    }
  }
  for (const p of portals) if (!placed.has(p.id)) out.push({ id: p.id, kind: 'portal', title: portalTitle(p), depth: 0, rect: rect(p), room: portalRoom(p) });
  return out;
}
