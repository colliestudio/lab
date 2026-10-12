import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Store, roomDbName, type App, type CanvasNode } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerChessLogic } from '../chess';
import { isPiece, piece, squarePos } from '../chess/model';
import { FRAME, PORTAL } from './model';

// The demo: an index canvas (three frames: agenda, sprint board, game night) whose last frame holds
// a portal into a second room with a chess game under way.

export const DEMO_ROOM = 'frames-demo-chess';

/** Build the chess room's doc: a board with a few opening moves and a note. */
export function buildChessRoom(doc: Y.Doc) {
  const store = new Store({ ydoc: doc });
  registerCoreCommands(store);
  registerChessLogic(store);
  store.dispatch('chess.create', { x: 0, y: 0 });
  const moves = [
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'c4'],
  ];
  for (const [from, to] of moves) {
    const p = store.doc.nodes.find((n) => isPiece(n) && piece(n).square === from);
    const b = p && store.doc.get(piece(p).board!);
    if (!p || !b) continue;
    const at = squarePos(b, to);
    store.dispatch('core.move', { ids: [p.id], dx: at.x - p.x, dy: at.y - p.y });
    store.dispatch('chess.place', { ids: [p.id] });
  }
  const b = store.doc.nodes.find((n) => !isPiece(n))!;
  store.dispatch('core.add', {
    nodes: [{ id: store.ctx.newId(), type: 'text', x: b.x, y: b.y - 150, width: b.width, height: 70, text: 'Game night · Italian game (1.e4 e5 2.Nf3 Nc6 3.Bc4), black to move' }],
  });
  return store;
}

/** Seed the chess room on this device unless it already has something in it. */
export async function seedChessRoom(room = DEMO_ROOM): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const probe = new Y.Doc();
  const p1 = new IndexeddbPersistence(roomDbName(room), probe);
  await p1.whenSynced;
  const empty = probe.getMap('nodes').size === 0;
  await p1.destroy();
  probe.destroy();
  if (!empty) return false;
  const doc = new Y.Doc();
  buildChessRoom(doc);
  const p2 = new IndexeddbPersistence(roomDbName(room), doc);
  await p2.whenSynced;
  await p2.destroy();
  doc.destroy();
  return true;
}

/** The index canvas's nodes, top-left at (x, y). Frames get z below `zBase`, contents above `zTop`. */
export function indexNodes(newId: () => string, x: number, y: number, zBase: number, zTop: number, room: string | null = DEMO_ROOM): CanvasNode[] {
  let z = zTop;
  let fz = zBase;
  const frame = (label: string, dx: number, w: number, h: number): CanvasNode => ({ id: newId(), type: 'group', label, x: x + dx, y, width: w, height: h, z: --fz, [FRAME]: {} });
  const text = (t: string, dx: number, dy: number, w = 240, h = 70, color?: string): CanvasNode => ({ id: newId(), type: 'text', text: t, x: x + dx, y: y + dy, width: w, height: h, z: ++z, ...(color ? { color } : {}) });
  return [
    frame('Agenda', 0, 640, 460),
    text('Team space · week 41', 40, 70, 560, 60),
    text('1. Sprint review: what shipped', 40, 160, 560),
    text('2. Plan the next sprint', 40, 250, 560),
    text('3. Game night', 40, 340, 560),

    frame('Sprint board', 760, 900, 460),
    text('To do', 800, 70, 260, 50),
    text('Doing', 1080, 70, 260, 50),
    text('Done', 1360, 70, 260, 50),
    text('Portal snapshots when small', 800, 140, 260, 80),
    text('Follow the presenter', 1080, 140, 260, 80),
    text('Frames + outline', 1360, 140, 260, 80),
    text('Present mode', 1360, 240, 260, 80),

    frame('Game night', 1780, 720, 660),
    ...(room === null
      ? [text('Game night. With ?portals=1 a live chess room shows here.', 1820, 90, 640, 70)]
      : [
          {
            id: newId(),
            type: 'file',
            file: `${room}.canvas`,
            label: 'Chess room',
            x: x + 1820,
            y: y + 70,
            width: 640,
            height: 470,
            z: ++z,
            [PORTAL]: { room },
          } as CanvasNode,
          text('Double-click the portal (or Enter ↗) to go into the chess room. Moves made there show here live.', 1820, 560, 640, 70),
        ]),
  ];
}

/** Put the demo on the table (right of what's there) and seed its chess room. One undo step. */
export async function seedDemo(app: App, portals = true): Promise<string[] | undefined> {
  if (portals) await seedChessRoom().catch(() => false);
  const doc = app.doc;
  const vis = doc.visible;
  const x = vis.length ? Math.max(...vis.map((n) => n.x + n.width)) + 300 : 0;
  const y = vis.length ? Math.min(...vis.map((n) => n.y)) : 0;
  const zs = doc.nodes.map((n) => n.z ?? 0);
  const minZ = zs.length ? Math.min(...zs) : 0;
  const nodes = indexNodes(app.store.ctx.newId, x, y, minZ, doc.topZ, portals ? DEMO_ROOM : null);
  app.store.newUndoStep();
  app.dispatch('core.add', { nodes });
  return nodes.map((n) => n.id);
}
