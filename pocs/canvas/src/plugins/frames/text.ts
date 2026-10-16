import type { CanvasNode, DocView } from '../../core/doc';
import { titleOf } from '../../core/query';
import { frameField, frameTitle, isFrame, isPortal, orderedFrames, portalRoom, portalTitle } from './model';

// The frames as data and as text for agents: presentation order, what is inside each, what is in
// none. Node-safe (no DOM).

export interface FrameMember {
  id: string;
  title: string;
  type: string;
}
export interface FrameInfo {
  /** 1-based place in the order, skipped frames included (what frames.reorder takes). */
  n: number;
  id: string;
  title: string;
  /** Position among the slides; absent when skipped. */
  slide?: number;
  skipped: boolean;
  depth: number;
  /** Title of the frame this one is inside. */
  parent?: string;
  rect: { x: number; y: number; width: number; height: number };
  inside: FrameMember[];
  portals: { id: string; title: string; room?: string }[];
}
export interface FramesView {
  frames: FrameInfo[];
  loose: FrameMember[];
  strayPortals: { id: string; title: string; room?: string }[];
}

const member = (n: CanvasNode): FrameMember => ({ id: n.id, title: titleOf(n) || n.type, type: n.type });
const portal = (n: CanvasNode) => ({ id: n.id, title: portalTitle(n), room: portalRoom(n) });

export function framesOf(doc: DocView): FramesView {
  const ordered = orderedFrames(doc);
  let slide = 0;
  const frames = ordered.map((f, i): FrameInfo => {
    const skipped = !!frameField(f).skip;
    let depth = 0;
    for (let c = doc.carrierOf(f.id); c && depth < 20; c = doc.carrierOf(c)) depth++;
    const parent = doc.carrierOf(f.id);
    const riders = doc.riders(f.id).filter((n) => doc.isVisible(n.id)).sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      n: i + 1,
      id: f.id,
      title: frameTitle(f, i),
      ...(skipped ? {} : { slide: ++slide }),
      skipped,
      depth,
      ...(parent && isFrame(doc.get(parent)) ? { parent: frameTitle(doc.get(parent)!) } : {}),
      rect: { x: f.x, y: f.y, width: f.width, height: f.height },
      inside: riders.filter((n) => !isPortal(n)).map(member),
      portals: riders.filter(isPortal).map(portal),
    };
  });
  const placed = new Set(frames.flatMap((f) => f.portals.map((p) => p.id)));
  return {
    frames,
    loose: doc.visible
      .filter((n) => !(isFrame(n) as boolean) && !(isPortal(n) as boolean) && !doc.carrierOf(n.id))
      .map(member),
    strayPortals: doc.nodes.filter((n) => isPortal(n) && !placed.has(n.id)).map(portal),
  };
}

const CAP = 15;
const quote = (m: { title: string; id: string }) => `“${m.title}” (${m.id})`;
const list = (xs: FrameMember[]) => xs.slice(0, CAP).map(quote).join(', ') + (xs.length > CAP ? `, … (+${xs.length - CAP} more)` : '');

export function framesText(v: FramesView): string {
  if (!v.frames.length && !v.strayPortals.length) return 'No frames yet. frames.create {around: [ids], label} frames what you drew; frames.create {label} makes an empty one right of everything.';
  const slides = v.frames.filter((f) => !f.skipped).length;
  const out = [`Frames, in presentation order (${v.frames.length} frame${v.frames.length === 1 ? '' : 's'}, ${slides} slide${slides === 1 ? '' : 's'}):`];
  for (const f of v.frames) {
    const head = [`${f.n}. ${f.title} (${f.id})`, f.skipped ? 'skipped' : `slide ${f.slide}`, f.parent && `in ${f.parent}`, `${f.rect.x},${f.rect.y} ${f.rect.width}x${f.rect.height}`, f.inside.length ? `${f.inside.length} inside: ${list(f.inside)}` : 'empty'];
    out.push(' ' + head.filter(Boolean).join(' · '));
    for (const p of f.portals) out.push(`      portal ${quote(p)} → room ${p.room ?? '?'}`);
  }
  if (v.strayPortals.length) out.push('Portals outside frames: ' + v.strayPortals.map((p) => `${quote(p)} → room ${p.room ?? '?'}`).join(', '));
  if (v.loose.length) out.push('Not in a frame: ' + list(v.loose));
  return out.join('\n');
}
