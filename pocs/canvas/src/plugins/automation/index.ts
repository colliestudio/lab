import './automation.css';
import type { App, CanvasNode, MenuEntry, Plugin } from '../../core';
import { handLabelOf, seats } from '../cards';
import { registerAutomationLogic, resolve } from './commands';
import { editButton } from './editor';
import { BUTTON_H, BUTTON_W, buttonOf, describeStep, isButton, targetText, type ButtonField } from './model';

/** Players at the table (me first): who "deal to players" deals to. */
const players = (app: App) =>
  seats(app)
    .filter((p) => !p.away)
    .map((p) => ({ id: p.id, label: handLabelOf(p.name), color: p.color }));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function runButton(app: App, id: string, cause?: string, merge = false) {
  return app.dispatch('auto.run', { id, players: players(app), now: Date.now(), cause }, { merge });
}

export async function openEditor(app: App, n: CanvasNode) {
  const r = await editButton(app, buttonOf(n));
  if (!r) return;
  const res = app.dispatch('auto.edit', { id: n.id, name: r.draft.name, steps: r.draft.steps, trigger: r.draft.trigger ?? { on: 'click' } });
  if (!res.ok) return app.notify('Could not save the steps');
  if (r.run) runButton(app, n.id);
}

function buttonHtml(b: ButtonField): string {
  const rule = b.trigger?.on === 'enter';
  const meta = `${b.steps.length} step${b.steps.length === 1 ? '' : 's'}${rule && b.trigger?.on === 'enter' ? ` · ⚡ when a card enters ${esc(targetText(b.trigger.zone))}` : ''}`;
  const title = esc(b.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n') || 'No steps yet');
  return `<div class="au-button${rule ? ' au-rule' : ''}" title="${title}">
    <button class="au-run" data-action="run">${rule ? '⚡' : '▶'} ${esc(b.name)}</button>
    <div class="au-meta"><span>${meta}</span><button class="au-edit" data-action="edit" title="Edit steps">✎ steps</button></div>
  </div>`;
}

export const automationPlugin: Plugin = {
  id: 'automation',
  setup(app) {
    registerAutomationLogic(app.store);

    app.registerType({
      id: 'automation.button',
      match: isButton,
      render(node, el) {
        el.innerHTML = buttonHtml(buttonOf(node));
      },
      onAction(node, action, a) {
        if (action === 'run') runButton(a, node.id);
        else if (action === 'edit') void openEditor(a, node);
      },
      onDoubleClick(node, a) {
        void openEditor(a, node);
      },
    });

    app.registerKit({
      id: 'automation.button',
      label: 'Button (automation)',
      create: (a, at) => {
        const res = a.dispatch('auto.create', { x: at.x - BUTTON_W / 2, y: at.y - BUTTON_H / 2, name: 'New button', steps: [{ do: 'log', text: 'pressed the button' }] });
        const id = res.select?.[0];
        const n = id && a.node(id);
        if (n) void openEditor(a, n);
      },
    });
    app.registerKit({ id: 'automation.tienlen', label: 'Tiến Lên table + buttons', create: (a, at) => a.dispatch('auto.tienlen', { ...at, players: players(a) }) });
    app.registerKit({ id: 'automation.retro', label: 'Retro board + buttons (work)', create: (a, at) => a.dispatch('auto.retro', at) });

    app.registerMenu((a, sel) => {
      if (sel.length !== 1 || !isButton(sel[0])) return;
      const n = sel[0];
      const b = buttonOf(n);
      const entries: MenuEntry[] = [
        { label: `Run ${b.name}`, run: () => runButton(a, n.id) },
        { label: 'Edit steps…', run: () => void openEditor(a, n) },
        {
          label: 'Copy steps as JSON',
          run: () => {
            void navigator.clipboard?.writeText(JSON.stringify(b, null, 2)).then(
              () => a.notify('Steps copied'),
              () => a.notify('Clipboard needs https'),
            );
          },
        },
      ];
      return { title: b.trigger?.on === 'enter' ? 'Rule' : 'Button', entries };
    });

    // Triggers: a card entering a zone runs the rules watching it, on the device of the player who
    // moved it (so it runs once), in the same undo step. Undo, remote changes and runs don't trigger.
    app.store.onDispatch((name, _args, res) => {
      if (name.startsWith('auto.')) return;
      const entered = new Set<string>();
      for (const c of res.changes) if (c.op === 'set' && c.key === 'x-cards.stack' && typeof c.value === 'string') entered.add(c.value);
      if (!entered.size) return;
      for (const n of app.doc.nodes) {
        if (!isButton(n)) continue;
        const t = buttonOf(n).trigger;
        if (t?.on !== 'enter') continue;
        const zones = resolve(app.doc, t.zone);
        const hit = zones.find((z) => entered.has(z.id));
        if (hit) runButton(app, n.id, `a card entered ${targetText(t.zone)}`, true);
      }
    });
  },
};

export { registerAutomationLogic } from './commands';
