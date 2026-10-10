import './clock.css';
import type { App, CanvasNode, Command, MenuEntry, Plugin, Store } from '../../core';
import { commands } from './commands';
import { repairImport, shapeExport } from './io';
import { PRESETS, baseOf, clock, controlText, fmt, incOf, isClock, nameOf, remaining, ticking, type Side } from './model';
import { clockHtml } from './render';

// A two-sided game clock for any game. Time state syncs as plain fields; each client draws the
// countdown itself (a ticker below). Taps, pause, flag, reset and time controls aren't undoable.

const NO_UNDO = { undoable: false } as const;

/** The data side of the plugin. No DOM; used by tests too. */
export function registerClockLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`clock.${name}`, cmd as Command);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.resets.push(commands.resetAll as Command);
}

const tapSide = (app: App, n: CanvasNode, side: Side) => app.dispatch('clock.tap', { id: n.id, side, now: Date.now() }, NO_UNDO);

/** Middle button / Space: start (White's time), pause, resume. */
function toggle(app: App, n: CanvasNode) {
  const c = clock(n);
  const now = Date.now();
  if (c.flag !== undefined) return;
  if (c.paused) app.dispatch('clock.resume', { id: n.id, now }, NO_UNDO);
  else if (c.run === undefined) tapSide(app, n, 1);
  else app.dispatch('clock.pause', { id: n.id, now }, NO_UNDO);
}

function settings(app: App, n: CanvasNode): MenuEntry[] {
  const id = n.id;
  const c = clock(n);
  const ctl = (s: Side) => `${+(baseOf(c, s) / 60000).toFixed(2)}+${+(incOf(c, s) / 1000).toFixed(1)}`;
  const time: MenuEntry[] = PRESETS.map(([label, m, s]) => ({
    label,
    checked: c.base === m * 60000 && c.inc === s * 1000 && c.base1 === undefined,
    run: () => app.dispatch('clock.control', { id, base: m * 60000, inc: s * 1000 }, NO_UNDO),
  }));
  time.push(
    {
      label: 'Custom, same for both…',
      separator: true,
      run: () => {
        const m = parseControl(prompt('Minutes + increment seconds for both sides, e.g. 25+10', ctl(0)));
        if (m) app.dispatch('clock.control', { id, base: m.base, inc: m.inc }, NO_UNDO);
      },
    },
    {
      label: 'Custom per side (handicap)…',
      checked: c.base1 !== undefined,
      run: () => {
        const v = prompt(`Handicap: ${nameOf(c, 0)} / ${nameOf(c, 1)}, minutes + increment seconds each, e.g. 5+0 / 3+2`, `${ctl(0)} / ${ctl(1)}`);
        const [a, b] = (v ?? '').split('/').map(parseControl);
        if (a && b) app.dispatch('clock.control', { id, base: a.base, inc: a.inc, base1: b.base, inc1: b.inc }, NO_UNDO);
      },
    },
  );
  const running = c.flag === undefined && c.run !== undefined;
  return [
    { label: `Time control: ${controlText(c)}`, items: time },
    {
      label: c.paused ? 'Resume' : c.run === undefined ? `Start (${nameOf(c, 0)})` : 'Pause',
      hint: 'Space',
      disabled: c.flag !== undefined ? 'Out of time: reset first' : false,
      run: () => toggle(app, n),
    },
    { label: 'Reset clock', disabled: !running && c.flag === undefined && c.left0 === baseOf(c, 0) && c.left1 === baseOf(c, 1) ? 'Already reset' : false, run: () => app.dispatch('clock.reset', { id }, NO_UNDO) },
    { label: `Rotate 90° (now ${c.rot ?? 0}°)`, hint: 'R', separator: true, run: () => app.dispatch('clock.rotate', { id }) },
    {
      label: 'Side names…',
      run: () => {
        const v = prompt('Left / right side names (empty = White / Black)', [c.name0 ?? '', c.name1 ?? ''].join(' / '));
        if (v === null) return;
        const [name0, name1] = v.split('/').map((s) => s.trim());
        app.dispatch('clock.names', { id, name0, name1 });
      },
    },
  ];
}

/** "5+3" / "25" / "0.5+2" → ms, or undefined. */
export function parseControl(v: string | null | undefined) {
  const m = v?.match(/^\s*(\d+(?:\.\d+)?)\s*(?:\+\s*(\d+(?:\.\d+)?))?\s*$/);
  return m ? { base: Number(m[1]) * 60000, inc: Number(m[2] ?? 0) * 1000 } : undefined;
}

/** The clock under the mouse. */
function hoveredClock(app: App) {
  const h = app.view.hovered && app.node(app.view.hovered);
  return h && isClock(h) ? h : undefined;
}
/** The clock a key aims at: under the mouse, else the selected one. */
function targetClock(app: App) {
  return hoveredClock(app) ?? app.selected().filter(isClock).at(-1);
}

export const clockPlugin: Plugin = {
  id: 'clock',
  setup(app) {
    registerClockLogic(app.store);
    app.registerKit({ id: 'clock.game', label: 'Game clock', create: (a, at) => a.dispatch('clock.create', at) });

    app.registerType({
      id: 'clock',
      match: isClock,
      render(node, el) {
        el.innerHTML = clockHtml(clock(node), Date.now());
      },
      onAction(node, action, app) {
        if (action === 'tap0' || action === 'tap1') tapSide(app, node, action === 'tap0' ? 0 : 1);
        else if (action === 'toggle') toggle(app, node);
      },
      onClick(node, down, app) {
        const tab = (down.target as Element | null)?.closest?.('[data-grip]');
        if (!tab) return false;
        app.view.openMenu(settings(app, node), tab, 'Game clock');
        return true;
      },
    });

    // Space over (or with) a clock: the running side's tap (or start / resume)
    app.registerKey({
      key: 'space',
      label: 'Tap the clock',
      // only with the pointer on the clock: anywhere else Space keeps panning
      when: (a) => !!hoveredClock(a),
      run: (a) => {
        const n = hoveredClock(a);
        if (!n) return;
        const c = clock(n);
        if (c.run === undefined || c.paused) toggle(a, n);
        else tapSide(a, n, c.run);
      },
    });

    app.registerKey({
      key: 'r',
      label: 'Rotate the clock',
      when: (a) => !!targetClock(a),
      run: (a) => {
        const n = targetClock(a);
        if (n) a.dispatch('clock.rotate', { id: n.id });
      },
    });

    app.registerMenu((a, sel) => (sel.length === 1 && isClock(sel[0]) ? { title: 'Game clock', entries: settings(a, sel[0]) } : undefined));

    // Ticker: redraw running times, mark low time, report a flag when time runs out.
    if (typeof window === 'undefined') return;
    setInterval(() => {
      const now = Date.now();
      for (const n of app.doc.visible) {
        if (!isClock(n)) continue;
        const c = clock(n);
        if (c.run === undefined || !ticking(c, c.run)) continue;
        const box = app.view.boxOf(n.id);
        const left = remaining(c, c.run, now);
        if (left <= 0) {
          app.dispatch('clock.flag', { id: n.id, now }, NO_UNDO);
          continue;
        }
        const t = box?.querySelector<HTMLElement>(`.ck-time[data-side="${c.run}"]`);
        if (!t) continue;
        const text = fmt(left);
        if (t.textContent !== text) t.textContent = text;
        t.classList.toggle('ck-low', left < 10_000);
      }
    }, 100);
  },
};

export { commands } from './commands';
