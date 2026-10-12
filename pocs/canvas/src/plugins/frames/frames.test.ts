import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CanvasNode } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerChessLogic } from '../chess';
import { isBoard, isPiece } from '../chess/model';
import { cameraFor, lerpCam } from './camera';
import { buildChessRoom, indexNodes } from './demo';
import { freezeMembership, registerFramesLogic, thawMembership } from './index';
import { frameAt, isFrame, isPortal, memberships, orderedFrames, outline, portalRoom, slides } from './model';
import { enterUrl, roomUrl, trailFromUrl } from './nav';
import { PortalRooms } from './portals';
import { presentersIn } from './present';

const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', x, y, width: w, height: h, ...extra });
const frame = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'group', x, y, width: w, height: h, 'x-frame': {}, ...extra });

function store(nodes: CanvasNode[] = [], chess = false) {
  const s = new Store();
  registerCoreCommands(s);
  if (chess) registerChessLogic(s);
  registerFramesLogic(s);
  s.load({ nodes, edges: [] });
  return s;
}

describe('model', () => {
  it('a group is a frame unless another plugin owns it; a .canvas file node is a portal', () => {
    expect(isFrame({ id: 'a', type: 'group', x: 0, y: 0, width: 1, height: 1 })).toBe(true); // an Obsidian group
    expect(isFrame(frame('a', 0, 0, 1, 1))).toBe(true);
    expect(isFrame({ id: 'a', type: 'group', x: 0, y: 0, width: 1, height: 1, 'x-cards': {} })).toBe(false); // a deck
    expect(isPortal({ id: 'p', type: 'file', file: 'boards/Sprint-12.canvas', x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isPortal({ id: 'p', type: 'file', file: 'notes.md', x: 0, y: 0, width: 1, height: 1 })).toBe(false);
  });
  it('portal room: explicit, else the file base name; junk is no room', () => {
    const p = (extra: Partial<CanvasNode>) => ({ id: 'p', type: 'file', x: 0, y: 0, width: 1, height: 1, ...extra }) as CanvasNode;
    expect(portalRoom(p({ file: 'boards/Sprint-12.canvas' }))).toBe('sprint-12');
    expect(portalRoom(p({ file: 'x.canvas', 'x-portal': { room: 'abc' } }))).toBe('abc');
    expect(portalRoom(p({ file: 'x.canvas', 'x-portal': { room: '../evil' } }))).toBeUndefined();
    expect(portalRoom(p({ file: 'my board.canvas' }))).toBeUndefined();
  });
  it('membership: center inside, innermost frame wins, never something bigger than the frame', () => {
    const nodes = [frame('outer', 0, 0, 1000, 1000), frame('inner', 100, 100, 300, 300), box('a', 150, 150, 50, 50), box('b', 600, 600, 50, 50), box('edge', 950, 950, 100, 100), box('big', -10, -10, 1100, 1100)];
    const m = memberships(nodes);
    expect(m.get('a')).toBe('inner');
    expect(m.get('inner')).toBe('outer');
    expect(m.get('b')).toBe('outer');
    expect(m.get('edge')).toBeUndefined(); // center at 1000,1000: on the border, outside
    expect(m.get('big')).toBeUndefined();
    expect(m.get('outer')).toBeUndefined();
    expect(frameAt(box('x', 5000, 0, 1, 1), nodes)).toBeUndefined();
  });
  it('order: explicit order first, then reading order (rows, then left to right)', () => {
    const doc = { nodes: [frame('c', 0, 900, 100, 100), frame('b', 800, 0, 100, 100), frame('a', 0, 30, 100, 100)] };
    expect(orderedFrames(doc).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    doc.nodes[0]['x-frame'] = { order: 0 };
    expect(orderedFrames(doc).map((f) => f.id)).toEqual(['c', 'a', 'b']);
    doc.nodes[2]['x-frame'] = { skip: true };
    expect(slides(doc).map((f) => f.id)).toEqual(['c', 'b']);
  });
  it('outline: frames in order, slide numbers skip skipped frames, portals under their frame', () => {
    const nodes = [
      frame('f1', 0, 0, 500, 500, { label: 'Intro' }),
      frame('f2', 600, 0, 500, 500, { 'x-frame': { skip: true } }),
      frame('f3', 1200, 0, 500, 500),
      box('t', 10, 50, 10, 10),
      { id: 'p', type: 'file', file: 'chess.canvas', x: 1300, y: 100, width: 200, height: 200 } as CanvasNode,
      { id: 'q', type: 'file', file: 'loose.canvas', x: 5000, y: 0, width: 200, height: 200 } as CanvasNode,
    ];
    expect(outline({ nodes }).map((e) => [e.kind, e.title, e.slide, e.depth, e.count, e.room])).toEqual([
      ['frame', 'Intro', 1, 0, 1, undefined],
      ['frame', 'Frame 2', undefined, 0, 0, undefined],
      ['frame', 'Frame 3', 2, 0, 1, undefined],
      ['portal', 'chess', undefined, 1, undefined, 'chess'],
      ['portal', 'loose', undefined, 0, undefined, 'loose'],
    ]);
  });
});

describe('commands', () => {
  it('create around a selection: margin + title room, under everything, selected', () => {
    const s = store([box('a', 100, 100, 50, 50, { z: 3 }), box('b', 300, 200, 50, 50, { z: 5 })]);
    const r = s.dispatch('frames.create', { around: ['a', 'b'], label: 'Plan' });
    const f = s.doc.get(r.select![0])!;
    expect(f).toMatchObject({ type: 'group', label: 'Plan', x: 60, y: 24, width: 330, height: 266 });
    expect(f.z).toBeLessThan(3);
    expect(s.doc.riders(f.id).map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
  it('moving a frame carries its contents, and a chess board carries its pieces inside it', () => {
    const s = store([], true);
    s.dispatch('chess.create', { x: 0, y: 0 });
    s.dispatch('core.add', { nodes: [frame('f', -1000, -1000, 3000, 3000, { z: -10 })] });
    const boardId = s.doc.nodes.find(isBoard)!.id;
    expect(s.doc.carrierOf(boardId)).toBe('f');
    const piece = s.doc.nodes.find(isPiece)!;
    expect(s.doc.carrierOf(piece.id)).toBe(boardId); // the board's rule comes first
    s.dispatch('core.move', { ids: ['f'], dx: 100, dy: 0 });
    expect(s.doc.get(piece.id)!.x).toBe(piece.x + 100);
  });
  it('delete takes the contents; unframe keeps them', () => {
    const s = store([frame('f', 0, 0, 500, 500), box('a', 10, 50, 10, 10)]);
    s.dispatch('frames.unframe', { id: 'f' });
    expect(s.doc.get('a')).toBeDefined();
    s.undo();
    s.dispatch('core.delete', { ids: ['f'] });
    expect(s.doc.get('a')).toBeUndefined();
  });
  it('reorder writes explicit orders; skip works on a plain (Obsidian) group too', () => {
    const s = store([frame('a', 0, 0, 100, 100), frame('b', 200, 0, 100, 100), { id: 'c', type: 'group', x: 400, y: 0, width: 100, height: 100 }]);
    s.dispatch('frames.reorder', { id: 'c', to: 0 });
    expect(orderedFrames(s.doc).map((f) => f.id)).toEqual(['c', 'a', 'b']);
    s.dispatch('frames.skip', { id: 'c', skip: true });
    expect(slides(s.doc).map((f) => f.id)).toEqual(['a', 'b']);
    expect(isFrame(s.doc.get('c'))).toBe(true);
    s.dispatch('frames.skip', { id: 'c', skip: false });
    expect(slides(s.doc).map((f) => f.id)).toEqual(['c', 'a', 'b']);
    // a new frame goes to the end once frames have explicit orders
    const r = s.dispatch('frames.create', { x: -500, y: -500 });
    expect(orderedFrames(s.doc).at(-1)!.id).toBe(r.select![0]);
  });
  it('pin writes the current order down without changing it; a new frame goes last and pins the rest', () => {
    const s = store([frame('b', 800, 0, 100, 100), frame('a', 0, 0, 100, 100), { id: 'c', type: 'group', x: 400, y: 0, width: 100, height: 100 }]);
    const before = orderedFrames(s.doc).map((f) => f.id);
    s.dispatch('frames.pin', {});
    expect(orderedFrames(s.doc).map((f) => f.id)).toEqual(before);
    expect(s.doc.nodes.map((n) => (n['x-frame'] as { order?: number }).order).sort()).toEqual([0, 1, 2]);
    expect(s.dispatch('frames.pin', {}).changes).toEqual([]);
    // moving a pinned frame across the canvas no longer reorders the slides
    s.dispatch('core.move', { ids: ['a'], dx: 5000, dy: 3000 });
    expect(orderedFrames(s.doc).map((f) => f.id)).toEqual(before);
    // creating a frame between them in space still lands last, and the others keep their places
    const r = s.dispatch('frames.create', { x: 100, y: 0 });
    expect(orderedFrames(s.doc).map((f) => f.id)).toEqual([...before, r.select![0]]);
  });
  it('sink puts frames back under every other node after a press raised them, keeping their order', () => {
    const s = store([frame('outer', 0, 0, 900, 900, { z: -2 }), frame('inner', 50, 50, 300, 300, { z: -1 }), box('a', 60, 60, 20, 20, { z: 3 }), box('loose', 2000, 0, 20, 20, { z: 5 })]);
    expect(s.dispatch('frames.sink', {}).changes).toEqual([]);
    s.dispatch('core.front', { ids: ['outer'] }); // what pressing a frame does
    expect(s.doc.get('outer')!.z).toBeGreaterThan(s.doc.get('loose')!.z!);
    s.dispatch('frames.sink', {});
    const z = (id: string) => s.doc.get(id)!.z!;
    expect(Math.max(z('outer'), z('inner'))).toBeLessThan(Math.min(z('a'), z('loose')));
    expect(z('inner')).toBeGreaterThan(z('outer')); // the inner frame rode with the outer one and stays above it
  });
  it('create on unordered frames pins them in reading order first', () => {
    const s = store([frame('b', 800, 0, 100, 100), frame('a', 0, 0, 100, 100)]);
    const r = s.dispatch('frames.create', { x: -900, y: 0 });
    expect(orderedFrames(s.doc).map((f) => f.id)).toEqual(['a', 'b', r.select![0]]);
  });
  it('resize has a minimum; bad args are a no-op', () => {
    const s = store([frame('f', 0, 0, 500, 500)]);
    s.dispatch('frames.resize', { id: 'f', width: 10, height: 900 });
    expect(s.doc.get('f')).toMatchObject({ width: 160, height: 900 });
    expect(s.dispatch('frames.resize', { id: 'f', width: 'x' }).changes).toEqual([]);
    expect(s.dispatch('frames.rename', { id: 'f', label: '   ' }).changes).toEqual([]);
  });
  it('portals: created as a JSON Canvas file node; bad room ids refused; retarget', () => {
    const s = store();
    expect(s.dispatch('frames.createPortal', { x: 0, y: 0, room: 'Not OK!' }).changes).toEqual([]);
    const id = s.dispatch('frames.createPortal', { x: 0, y: 0, room: 'sprint-12' }).select![0];
    expect(s.doc.get(id)).toMatchObject({ type: 'file', file: 'sprint-12.canvas', 'x-portal': { room: 'sprint-12' } });
    s.dispatch('frames.retarget', { id, room: 'sprint-13' });
    expect(portalRoom(s.doc.get(id)!)).toBe('sprint-13');
  });
  it('round-trips through a .canvas file: frames are groups, portals file nodes', () => {
    const s = store();
    s.load({ nodes: indexNodes(() => Math.random().toString(36).slice(2), 0, 0, 0, 0), edges: [] });
    const text = serialize(s.exportDoc());
    const back = parse(text);
    expect(back.nodes.filter((n) => n.type === 'group').map((n) => n.label).sort()).toEqual(['Agenda', 'Game night', 'Sprint board']);
    expect(back.nodes.find((n) => n.type === 'file')).toMatchObject({ file: 'frames-demo-chess.canvas' });
    const s2 = store(back.nodes);
    expect(outline(s2.doc).map((e) => e.title)).toEqual(['Agenda', 'Sprint board', 'Game night', 'Chess room']);
  });
});

describe('frozen membership during a press', () => {
  it('a frame dragged over loose objects does not scoop them up; geometry decides again on release', () => {
    const s = store([frame('f', 0, 0, 200, 200), box('a', 50, 50, 10, 10), box('loose', 400, 50, 10, 10)]);
    freezeMembership(s.doc.nodes);
    try {
      for (let i = 0; i < 6; i++) s.dispatch('core.move', { ids: ['f'], dx: 50, dy: 0 }, { merge: i > 0 });
      expect(s.doc.get('loose')!.x).toBe(400); // passed over, left where it was
      expect(s.doc.get('a')!.x).toBe(350); // its own content came along
      expect(s.doc.carrierOf('loose')).toBeUndefined();
    } finally {
      thawMembership();
    }
    s.invalidate();
    expect(s.doc.carrierOf('loose')).toBe('f'); // dropped over it: now it's in the frame
  });
});

describe('camera', () => {
  it('fits a rect into the screen (inside insets) and interpolates between cameras', () => {
    const c = cameraFor({ x: 0, y: 0, width: 1000, height: 500 }, 1200, 700, 100);
    expect(c.zoom).toBe(1);
    expect(c.x).toBe(100);
    const i = cameraFor({ x: 0, y: 0, width: 100, height: 100 }, 1000, 1000, 0, 4, { top: 0, right: 200, bottom: 0, left: 0 });
    expect(i.x + 50 * i.zoom).toBe(400); // centered in the uncovered 800 px
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: -500, y: -200, zoom: 4 };
    expect(lerpCam(a, b, 0, 800, 600)).toEqual(a);
    const end = lerpCam(a, b, 1, 800, 600);
    expect(end.x).toBeCloseTo(b.x);
    expect(end.zoom).toBeCloseTo(4);
    expect(lerpCam(a, b, 0.5, 800, 600).zoom).toBeCloseTo(2); // zoom moves geometrically
  });
});

describe('nav', () => {
  const loc = { href: 'http://h:1/?room=a&via=~&signal=ws://s', search: '?room=a&via=~&signal=ws://s' };
  it('entering a portal extends the trail; entering one on the trail goes back to it', () => {
    expect(trailFromUrl(loc)).toEqual(['~']);
    expect(enterUrl('b', 'a', ['~'], loc)).toBe('http://h:1/?room=b&signal=ws%3A%2F%2Fs&via=%7E%2Ca');
    expect(enterUrl('a', 'b', ['~', 'a'], loc)).toBe('http://h:1/?room=a&signal=ws%3A%2F%2Fs&via=%7E');
    expect(roomUrl('~', [], loc)).toBe('http://h:1/?signal=ws%3A%2F%2Fs');
    expect(trailFromUrl({ search: '?via=~,ok-1,<script>,a' })).toEqual(['~', 'ok-1', 'a']);
  });
});

describe('presenters from awareness', () => {
  it('takes only well-formed states from others', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: 'Me', color: '#123456' }, present: { frame: 'f', index: 0, count: 2, title: 'x' } }],
      [2, { user: { name: 'Bob', color: 'red;}' }, present: { frame: 'g', index: '1', count: 3, title: 'Plan' } }],
      [3, { user: { name: 'Eve' }, present: { frame: 42 } }],
      [4, { user: { name: 'Idle' }, present: null }],
    ]);
    expect(presentersIn(states, 1)).toEqual([{ clientId: 2, name: 'Bob', color: '#888', present: { frame: 'g', index: 1, count: 3, title: 'Plan' } }]);
  });
});

describe('portal rooms', () => {
  it('one doc per room, read with the app’s rules, live from its transport, closed when unused', async () => {
    const main = store([], true);
    // the "other room": a doc another player edits; the transport relays updates both ways
    const remote = new Y.Doc();
    const remoteStore = buildChessRoom(remote);
    const rooms = new PortalRooms(main, {
      persist: false,
      connect: (_room, doc) => {
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
        const fwd = (u: Uint8Array, origin: unknown) => origin !== 'relay' && Y.applyUpdate(doc, u, 'relay');
        remote.on('update', fwd);
        return { destroy: () => remote.off('update', fwd) };
      },
    });
    let heard = 0;
    const a = rooms.open('chess', () => heard++);
    const b = rooms.open('chess', () => {});
    expect(a.doc).toBe(b.doc);
    const view = a.doc.store.doc;
    const piece = view.nodes.find(isPiece)!;
    expect(view.carrierOf(piece.id)).toBe(piece['x-chess'] && (piece['x-chess'] as { board: string }).board); // chess rider rule via adoptViewRules
    remoteStore.dispatch('core.move', { ids: [piece.id], dx: 0, dy: -64 });
    expect(a.doc.store.doc.get(piece.id)!.y).toBe(piece.y - 64);
    expect(heard).toBeGreaterThan(0);
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 2100));
    expect(rooms.openRooms()).toEqual([]);
  });
});
