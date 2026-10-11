import { Scratch, isNum, type CanvasNode, type Command, type Store } from '../../core';
import type { Seat } from '../mats/presets';
import { TIENLEN_STRIP } from '../mats/presets';
import { freeZoneNode, isMat } from '../mats/model';
import { W as CLOCK_W, clockNode } from '../clock/model';
import { BUTTON_H, BUTTON_W, buttonNode, type ButtonField } from './model';

// Demo tables with buttons. Each is one command (one undo step) built from other commands.

export const TIENLEN_BUTTONS: ButtonField[] = [
  {
    name: 'Deal Tiến Lên',
    steps: [
      { do: 'shuffle', target: { name: 'Main' } },
      { do: 'deal', from: { name: 'Main' }, count: 13 },
      { do: 'move', what: { kind: 'card', in: 'Main' }, to: { name: 'Set aside' } },
    ],
  },
  {
    name: 'New round',
    steps: [
      { do: 'gather', target: { name: 'Main' } },
      { do: 'flip', target: { name: 'Main' }, faceUp: false },
      { do: 'shuffle', target: { name: 'Main' } },
    ],
  },
  {
    name: 'Clear the pile',
    steps: [
      { do: 'stop', when: { target: { name: 'Pile' }, is: 'empty' } },
      { do: 'move', what: { kind: 'card', in: 'Pile' }, to: { name: 'Set aside' } },
      { do: 'log', text: 'everyone passed: new lead' },
    ],
  },
  {
    name: 'Someone went out',
    trigger: { on: 'enter', zone: { name: 'Pile' } },
    steps: [
      { do: 'stop', when: { target: { kind: 'hand' }, is: 'not-empty' } },
      { do: 'log', text: 'played their last card: round over (New round to play again)' },
    ],
  },
];

export const RETRO_PHASES = ['Brainstorm', 'Group', 'Vote', 'Actions'];
export const RETRO_BUTTONS: ButtonField[] = [
  {
    name: 'Next phase',
    steps: [
      { do: 'cycle', target: { kind: 'text', name: 'Phase' }, values: RETRO_PHASES },
      { do: 'clock', target: { kind: 'clock' }, action: 'reset' },
      { do: 'clock', target: { kind: 'clock' }, action: 'start' },
    ],
  },
  {
    name: 'Park “To improve”',
    steps: [
      { do: 'stop', when: { target: { name: 'To improve' }, is: 'empty' } },
      { do: 'move', what: { kind: 'text', in: 'To improve' }, to: { name: 'Parked' } },
    ],
  },
];

/** The newest mat after a run (the one the run just added). */
const newestMat = (nodes: readonly CanvasNode[], before: Set<string>) => nodes.find((n) => isMat(n) && !before.has(n.id));

/** Tiến Lên table (mats preset) with its buttons on the strip at the top, centered on (x, y). */
export function tienlenCommand(store: Store): Command<{ x?: number; y?: number; players?: Seat[] }> {
  return (doc, a, ctx) => {
    const run = new Scratch(store, doc, ctx);
    const before = new Set(doc.nodes.map((n) => n.id));
    run.call('mats.preset', { preset: 'tienlen', x: isNum(a?.x) ? a.x : 0, y: isNum(a?.y) ? a.y : 0, players: a?.players ?? [] });
    const m = newestMat(run.doc.nodes, before);
    if (!m) return [];
    let z = Math.floor(run.doc.topZ);
    const gap = 24;
    TIENLEN_BUTTONS.forEach((b, i) => {
      const x = m.x + 80 + i * (BUTTON_W + gap);
      run.push([{ op: 'add', node: buttonNode(ctx.newId(), x, m.y + (TIENLEN_STRIP - BUTTON_H) / 2 + 4, ++z, b) }]);
    });
    return { changes: run.changes, events: [{ type: 'auto.kit', text: 'added a Tiến Lên table with buttons', targets: [m.id] }], select: [] };
  };
}

/** A retro board: four areas, a few notes, a phase note, a 5-minute timebox clock and two buttons. */
export function retroCommand(store: Store): Command<{ x?: number; y?: number }> {
  return (doc, a, ctx) => {
    const run = new Scratch(store, doc, ctx);
    const before = new Set(doc.nodes.map((n) => n.id));
    const cx = isNum(a?.x) ? a.x : 0;
    const cy = isNum(a?.y) ? a.y : 0;
    const W = 1500;
    const H = 860;
    run.call('mats.create', { x: cx, y: cy, w: W, h: H, label: 'Retro', color: '#3d434c' });
    const m = newestMat(run.doc.nodes, before);
    if (!m) return [];
    const top = m.y + 200;
    const areaW = Math.round((W - 5 * 30) / 4);
    let z = Math.floor(run.doc.topZ);
    const col = (i: number) => m.x + 30 + i * (areaW + 30);
    run.push(['Went well', 'To improve', 'Actions', 'Parked'].map((name, i) => ({ op: 'add' as const, node: freeZoneNode(ctx.newId(), m.id, col(i), top, areaW, 620, ++z, name) })));
    const note = (id: string, x: number, y: number, text: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', x: Math.round(x), y: Math.round(y), width: 200, height: 90, z: ++z, text, color: '3', ...extra });
    run.push([
      { op: 'add', node: note(ctx.newId(), m.x + 30, m.y + 40, 'Brainstorm', { label: 'Phase', width: 260, height: 70, color: '6' }) },
      { op: 'add', node: note(ctx.newId(), col(0) + 16, top + 50, 'Demo landed on time') },
      { op: 'add', node: note(ctx.newId(), col(0) + 16, top + 156, 'Pairing on the sync bug') },
      { op: 'add', node: note(ctx.newId(), col(1) + 16, top + 50, 'Flaky e2e tests', { color: '1' }) },
      { op: 'add', node: note(ctx.newId(), col(1) + 16, top + 156, 'Too many meetings', { color: '1' }) },
      { op: 'add', node: note(ctx.newId(), col(1) + 16, top + 262, 'Unclear owner for CI', { color: '1' }) },
    ]);
    run.push([{ op: 'add', node: clockNode(ctx.newId(), m.x + W - 30 - CLOCK_W, m.y + 25, 5 * 60000, 0, ++z) }]);
    const gap = 24;
    RETRO_BUTTONS.forEach((b, i) => run.push([{ op: 'add', node: buttonNode(ctx.newId(), m.x + 330 + i * (BUTTON_W + gap), m.y + 37, ++z, b) }]));
    return { changes: run.changes, untracked: run.untracked, events: [{ type: 'auto.kit', text: 'added a retro board with buttons', targets: [m.id] }], select: [] };
  };
}
