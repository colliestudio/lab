import './storm.css';
import type { App, CanvasNode, KeyBinding, MenuEntry, Plugin } from '../../core';
import { boardOf, eventsOn, votesCast } from './commands';
import { registerStormLogic } from './logic';
import { toMarkdown } from './markdown';
import { KINDS, KIND_ORDER, PHASES, PHASE_INFO, board, isBoard, isEvent, isSticky, isStorm, kindOf, lanesOf, offered, phaseOf, sticky, timerLeft, votesOf, type StickyKind } from './model';
import { fmt } from '../clock/model';
import { boardHtml, markdownDialog, stickyHtml } from './render';

// Event storming kit: a timeline board, eight sticky kinds with a key each, type-to-create with
// Tab chaining, a phase switch, dot voting, a timebox and a Markdown export of the flow.

const NO_UNDO = { undoable: false } as const;
const onGrip = (down: PointerEvent) => !!(down.target as Element | null)?.closest?.('[data-grip]');

/**
 * Bind `k.key` without taking it from another plugin: mine runs when `k.when` says so, else the
 * key does what it did before. (Core keeps one binding per key; a plugin API gap, see ideas/eventstorm.md.)
 */
function chainKey(app: App, k: KeyBinding & { when(app: App): boolean }) {
  const prev = app.keys.get(k.key);
  if (!prev) return app.registerKey(k);
  app.registerKey({
    key: k.key,
    label: k.label,
    when: (a) => k.when(a) || !prev.when || prev.when(a),
    run: (a) => (k.when(a) ? k.run(a) : prev.run(a)),
  });
}

export const stormPlugin: Plugin = {
  id: 'eventstorm',
  setup(app) {
    registerStormLogic(app.store);

    // ------------------------------------------------------------ where the pointer is (new stickies go there)
    let pointer: { x: number; y: number } | undefined;
    app.view.root.addEventListener('pointermove', (e) => {
      const r = app.view.root.getBoundingClientRect();
      const [x, y] = app.viewport.toWorld(e.clientX - r.left, e.clientY - r.top);
      pointer = { x, y };
    });

    const voters = () => {
      const m = new Map<string, string>();
      for (const e of app.store.log.toArray()) if (e.actor) m.set(e.actor.id, e.actor.color);
      for (const n of app.doc.nodes) if (isSticky(n) && sticky(n).by) m.set(sticky(n).by!.id, sticky(n).by!.color);
      for (const p of app.presence?.peers() ?? []) m.set(p.id, p.color);
      const me = app.me();
      m.set(me.id, me.color);
      return m;
    };
    const author = () => {
      const m = app.me();
      return { id: m.id, name: m.name, color: m.color };
    };

    // ------------------------------------------------------------ target board
    const hoveredNode = () => (app.view.hovered ? app.node(app.view.hovered) : undefined);
    const targetBoard = (): CanvasNode | undefined => {
      const h = hoveredNode();
      const fromHover = h && boardOf(app.doc, h);
      if (fromHover) return fromHover;
      const sel = app.selected().map((n) => boardOf(app.doc, n)).find(Boolean);
      if (sel) return sel;
      const all = app.doc.nodes.filter(isBoard);
      return all.length === 1 ? all[0] : undefined;
    };
    /** Storm keys apply: there is a board and neither the selection nor the hovered object is someone else's (a deck, a chess piece). */
    const stormKeys = (a: App) => {
      if (!a.doc.nodes.some(isBoard)) return false;
      const h = hoveredNode();
      if (h && !isStorm(h)) return false;
      return a.selected().every(isStorm);
    };

    // ------------------------------------------------------------ editing a sticky's words (local to this screen)
    let editing: string | null = null;
    let fresh = false;
    let committing = false;
    const startEdit = (id: string, isNew = false) => {
      editing = id;
      fresh = isNew;
      app.store.select([id]);
      app.view.render();
      const ta = app.view.boxOf(id)?.querySelector<HTMLTextAreaElement>('textarea.es-edit');
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    const endEdit = (how: 'commit' | 'cancel'): string | undefined => {
      if (!editing || committing) return;
      committing = true;
      const id = editing;
      const ta = app.view.boxOf(id)?.querySelector<HTMLTextAreaElement>('textarea.es-edit');
      const value = ta?.value ?? '';
      editing = null;
      try {
        if (how === 'cancel' && fresh && !(app.node(id)?.text ?? '').trim()) {
          app.dispatch('core.delete', { ids: [id] }, { merge: true });
          return;
        }
        if (how === 'commit') {
          if (fresh && !value.trim()) app.dispatch('core.delete', { ids: [id] }, { merge: true });
          else app.dispatch('storm.text', { id, text: value }, { merge: fresh });
        }
        app.view.render();
        app.view.root.focus({ preventScroll: true });
        return id;
      } finally {
        committing = false;
        fresh = false;
      }
    };

    /** Make a sticky of `kind` where it makes sense, then type into it. */
    const create = (kind: StickyKind, opts: { after?: string; at?: { x: number; y: number } } = {}) => {
      const b = targetBoard();
      if (!b) return app.notify(app.doc.nodes.some(isBoard) ? 'Point at a board first' : 'No board yet: Add… › Event storm board');
      if (!offered(phaseOf(b)).includes(kind)) {
        const need = PHASES.find((p) => offered(p).includes(kind))!;
        return app.notify(`${KINDS[kind].name}s come in phase “${PHASE_INFO[need].name}” (switch phase on the board)`);
      }
      const sel = app.selected().filter(isSticky).at(-1);
      const args: Record<string, unknown> = { board: b.id, kind, by: author() };
      if (opts.after) args.after = opts.after;
      else if (sel && kind !== 'event') args.on = isEvent(sel) ? sel.id : sticky(sel).on;
      else if (sel && kind === 'event' && phaseOf(b) !== 'explore') args.after = sel.id;
      if (!args.after && !args.on) {
        const p = opts.at ?? pointer;
        const onBoard = p && p.x > b.x && p.x < b.x + b.width && p.y > b.y + 70 && p.y < b.y + b.height;
        const at = onBoard ? p : { x: b.x + 140 + Math.random() * 300, y: b.y + 200 + Math.random() * 200 };
        args.x = at!.x;
        args.y = at!.y;
        if (!onBoard) {
          // keys with no pointer on the board: don't make a sticky nobody can see
          const vp = app.viewport;
          const r = app.view.root;
          const sx = at!.x * vp.zoom + vp.x;
          const sy = at!.y * vp.zoom + vp.y;
          if (sx < 0 || sy < 0 || sx > r.clientWidth || sy > r.clientHeight) vp.set(r.clientWidth / 2 - at!.x * vp.zoom, r.clientHeight / 2 - at!.y * vp.zoom, vp.zoom);
        }
      }
      app.store.newUndoStep();
      const id = app.dispatch('storm.add', args).select?.[0];
      if (id) startEdit(id, true);
    };

    // editor keys: Enter commits, Shift+Enter a new line, Tab commits and chains the next sticky, Esc cancels
    app.view.root.addEventListener(
      'keydown',
      (e) => {
        const ta = e.target as HTMLElement;
        if (!ta.classList?.contains('es-edit')) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          endEdit('commit');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const id = endEdit('commit');
          const n = id ? app.node(id) : undefined;
          if (n) create(kindOf(n), { after: n.id });
        } else if (e.key === 'Escape') {
          e.preventDefault();
          endEdit('cancel');
        }
        e.stopPropagation();
      },
      true,
    );
    // a press inside the editor edits text (no drag, no deselect); a blur commits
    app.view.root.addEventListener(
      'pointerdown',
      (e) => {
        if ((e.target as Element).closest?.('textarea.es-edit')) e.stopPropagation();
        else if (editing && !(e.target as Element).closest?.(`[data-node-id="${editing}"]`)) endEdit('commit');
      },
      true,
    );
    app.view.root.addEventListener('focusout', (e) => {
      if ((e.target as HTMLElement).classList?.contains('es-edit')) setTimeout(() => editing && document.activeElement !== app.view.boxOf(editing)?.querySelector('textarea') && endEdit('commit'));
    });

    // ------------------------------------------------------------ export
    const showMarkdown = (b: CanvasNode) => {
      const md = toMarkdown(app.doc, b);
      (window as any).stormMarkdown = md;
      const d = markdownDialog(md, () => app.view.root.focus());
      document.body.append(d);
      // after the click that opened it (the export button takes focus on its own press)
      setTimeout(() => d.querySelector('textarea')?.focus());
      navigator.clipboard?.writeText(md).then(
        () => app.notify('Flow copied as Markdown'),
        () => undefined,
      );
    };

    // ------------------------------------------------------------ menus
    const boardMenu = (b: CanvasNode): MenuEntry[] => {
      const id = b.id;
      const f = board(b);
      const ph = phaseOf(b);
      return [
        { label: 'Phase', items: () => PHASES.map((p) => ({ label: PHASE_INFO[p].name, checked: p === ph, run: () => app.dispatch('storm.phase', { board: id, phase: p }) })) },
        { label: 'New sticky', items: () => offered(ph).map((k) => ({ label: KINDS[k].name, hint: KINDS[k].key.toUpperCase(), color: KINDS[k].color, run: () => create(k) })) },
        { label: 'Tidy the timeline', disabled: ph === 'explore' ? 'Chaotic exploration keeps stickies where they are' : false, run: () => app.dispatch('storm.tidy', { board: id }) },
        {
          label: 'Swimlanes…',
          separator: true,
          run: () => {
            const v = prompt('Swimlanes, top to bottom, comma separated (e.g. Customer, Shop, Warehouse)', lanesOf(b).join(', '));
            if (v !== null) app.dispatch('storm.lanes', { board: id, lanes: v.split(',') });
          },
        },
        {
          label: `Votes per person: ${f.dots}`,
          items: () => [0, 1, 2, 3, 5, 7, 10].map((k) => ({ label: String(k), checked: f.dots === k, run: () => app.dispatch('storm.dots', { board: id, dots: k }) })),
        },
        {
          label: `Timebox: ${fmt(f.timer.base)}`,
          items: () => [
            ...[2, 5, 10, 15, 25, 45].map((m) => ({ label: `${m} min`, checked: f.timer.base === m * 60000, run: () => app.dispatch('storm.timer', { board: id, action: 'set', minutes: m, now: Date.now() }, NO_UNDO) })),
            { label: 'Reset', separator: true, run: () => app.dispatch('storm.timer', { board: id, action: 'reset', now: Date.now() }, NO_UNDO) },
          ],
        },
        {
          label: 'Rename…',
          run: () => {
            const v = prompt('Board name', b.label ?? 'Event storm');
            if (v?.trim()) app.store.apply([{ op: 'set', id, key: 'label', value: v.trim().slice(0, 60) }]);
          },
        },
        { label: 'Export flow as Markdown', separator: true, run: () => showMarkdown(b) },
      ];
    };
    const stickyMenu = (n: CanvasNode): MenuEntry[] => {
      const b = boardOf(app.doc, n);
      const me = app.me().id;
      const mine = votesOf(n)[me];
      return [
        { label: 'Edit text', hint: '↵', run: () => startEdit(n.id) },
        { label: 'Vote', hint: '.', disabled: b && votesCast(app.doc, b.id, me) >= board(b).dots ? 'No votes left' : false, run: () => app.dispatch('storm.vote', { id: n.id, voter: me, delta: 1 }) },
        { label: 'Take a vote back', hint: ',', disabled: mine ? false : 'You haven’t voted on it', run: () => app.dispatch('storm.vote', { id: n.id, voter: me, delta: -1 }) },
        { label: 'Kind', items: () => KIND_ORDER.map((k) => ({ label: KINDS[k].name, color: KINDS[k].color, checked: kindOf(n) === k, run: () => app.dispatch('storm.kind', { id: n.id, kind: k }) })) },
        { label: 'Detach from its event', disabled: sticky(n).on ? false : 'Not attached', run: () => app.dispatch('storm.detach', { ids: [n.id] }) },
      ];
    };
    app.registerMenu((_a, sel) => {
      if (sel.length !== 1) return;
      const n = sel[0];
      if (isBoard(n)) return { title: n.label ?? 'Event storm', entries: boardMenu(n) };
      if (isSticky(n)) return { title: KINDS[kindOf(n)].name, entries: stickyMenu(n) };
    });

    // ------------------------------------------------------------ kit
    app.registerKit({
      id: 'storm.board',
      label: 'Event storm board',
      create: (a, at) => {
        const id = a.dispatch('storm.createBoard', at).select?.[0];
        const b = id && a.node(id);
        if (b) a.view.fit(80, [b]);
        a.store.select([]);
        a.notify('Event storm: press E to add a domain event, type, Tab for the next one');
      },
    });

    // ------------------------------------------------------------ the board
    app.registerType({
      id: 'storm-board',
      match: isBoard,
      render(node, el) {
        el.innerHTML = boardHtml(node, { dotsLeft: Math.max(0, board(node).dots - votesCast(app.doc, node.id, app.me().id)), now: Date.now() });
      },
      renderKey: (node) => `${JSON.stringify(node[`x-storm`])}:${node.label}:${node.width}x${node.height}:${votesCast(app.doc, node.id, app.me().id)}`,
      grabbable: (_n, down) => onGrip(down),
      boxSelectable: () => false,
      onClick(node, down, a) {
        if (!onGrip(down)) return false;
        a.view.openMenu(boardMenu(node), (down.target as Element).closest('[data-grip]')!, node.label ?? 'Event storm');
        return true;
      },
      onAction(node, action, a) {
        if (action.startsWith('phase:')) a.dispatch('storm.phase', { board: node.id, phase: action.slice(6) });
        else if (action.startsWith('add:')) {
          a.store.select([]);
          create(action.slice(4) as StickyKind);
        } else if (action === 'timer') {
          const t = board(node).timer;
          a.dispatch('storm.timer', { board: node.id, action: typeof t.since === 'number' ? 'pause' : timerLeft(t, Date.now()) > 0 ? 'start' : 'reset', now: Date.now() }, NO_UNDO);
        } else if (action === 'export') showMarkdown(node);
      },
    });

    // ------------------------------------------------------------ stickies
    app.registerType({
      id: 'storm-sticky',
      match: isSticky,
      render(node, el) {
        el.innerHTML = stickyHtml(node, { editing: editing === node.id, voters: voters() });
      },
      renderKey: (node) => `${node.text}:${node.color}:${node.width}x${node.height}:${JSON.stringify(node['x-storm'])}:${editing === node.id}`,
      onDoubleClick: (node) => startEdit(node.id),
      onAction(node, action, a) {
        if (action === 'vote') a.dispatch('storm.vote', { id: node.id, voter: a.me().id, delta: 1 });
      },
      onDragEnd(dragged, a) {
        a.dispatch('storm.settle', { ids: dragged.map((n) => n.id) });
      },
    });

    // ------------------------------------------------------------ keys
    for (const k of KIND_ORDER) chainKey(app, { key: KINDS[k].key, label: `New ${KINDS[k].name.toLowerCase()}`, when: stormKeys, run: () => create(k) });
    const one = (a: App) => {
      const h = hoveredNode();
      return h && isSticky(h) ? h : a.selected().filter(isSticky).at(-1);
    };
    chainKey(app, { key: 'enter', label: 'Edit the sticky', when: (a) => a.selected().length === 1 && isSticky(a.selected()[0]), run: (a) => startEdit(a.selected()[0].id) });
    chainKey(app, { key: '.', label: 'Vote', when: (a) => !!one(a), run: (a) => a.dispatch('storm.vote', { id: one(a)!.id, voter: a.me().id, delta: 1 }) });
    chainKey(app, { key: ',', label: 'Take a vote back', when: (a) => !!one(a), run: (a) => a.dispatch('storm.vote', { id: one(a)!.id, voter: a.me().id, delta: -1 }) });

    // ------------------------------------------------------------ timebox ticker
    if (typeof window === 'undefined') return;
    (window as any).storm = {
      /** The flow of every board as Markdown (for an agent driving the page). */
      markdown: () => app.doc.nodes.filter(isBoard).map((b) => toMarkdown(app.doc, b)).join('\n'),
      events: () => app.doc.nodes.filter(isBoard).flatMap((b) => eventsOn(app.doc, b.id).map((e) => e.text)),
    };
    let flagged = new Set<string>();
    setInterval(() => {
      const now = Date.now();
      for (const b of app.doc.nodes) {
        if (!isBoard(b)) continue;
        const t = board(b).timer;
        if (typeof t.since !== 'number') continue;
        const left = timerLeft(t, now);
        const el = app.view.boxOf(b.id)?.querySelector<HTMLElement>('.es-time');
        if (el && el.textContent !== fmt(left)) el.textContent = fmt(left);
        el?.parentElement?.classList.toggle('es-low', left < 30_000);
        if (left <= 0 && !flagged.has(b.id)) {
          flagged.add(b.id);
          app.notify('Timebox is over');
          app.logEvents([{ type: 'storm.timer', text: 'Timebox is over', actor: null, targets: [b.id], cue: 'pulse', key: `timeup:${b.id}:${t.since}` }]);
        }
        if (left > 0) flagged.delete(b.id);
      }
    }, 250);
  },
};

export { toMarkdown } from './markdown';
