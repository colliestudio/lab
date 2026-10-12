import './jsonPanel.css';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, keymap, type DecorationSet } from '@codemirror/view';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { App } from './app';
import { JsonSession, blocks, nodeAt } from './jsonView';

// The board as .canvas JSON in a code editor (CodeMirror 6), docked on the right. It shows the
// canonical text the bridge writes to disk, as this viewer may see it, and follows the live board.
// Edits are applied with ⌘S (or after a pause, with Auto): through JsonSession, so concurrent changes
// by others survive, as one undo step logged as the person. Selection is shared both ways. All the
// logic is in jsonView.ts; this file is editor wiring only, and the panel's contract with the app
// (text in, applied text out, selected ids both ways) is what a VS Code custom editor would also need.

const OPEN_KEY = 'canvas-poc:json-open';
const WIDTH_KEY = 'canvas-poc:json-width';
const AUTO_KEY = 'canvas-poc:json-auto';
const AUTO_DELAY = 900;
const FOLLOW_DELAY = 120;

const setMarks = StateEffect.define<{ from: number; to: number }[]>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      for (const r of e.value.slice().sort((a, c) => a.from - c.from)) b.add(r.from, r.to, Decoration.mark({ class: 'jp-selected' }));
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: '#9cdcfe' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.number, color: '#b5cea8' },
  { tag: [t.bool, t.null], color: '#569cd6' },
  { tag: t.punctuation, color: '#8a9a90' },
  { tag: t.brace, color: '#c9d1c8' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#101a15', color: '#d7e0d8', fontSize: '12.5px' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#0c1410', color: '#5f7266', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.06)' },
    '.cm-cursor': { borderLeftColor: '#e8efe9' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(90,140,200,0.35)' },
    '.cm-foldPlaceholder': { backgroundColor: '#24342b', border: 'none', color: '#9cb0a2' },
    '.cm-panels': { backgroundColor: '#16231c', color: '#d7e0d8' },
    '.cm-panels input, .cm-panels button': { fontSize: '12px' },
    '.cm-tooltip': { backgroundColor: '#16231c', border: '1px solid #2c4034', color: '#d7e0d8' },
    '.cm-searchMatch': { backgroundColor: 'rgba(255,200,60,0.3)' },
  },
  { dark: true },
);

export interface JsonPanel {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** The editor's current text (for tests and scripts). */
  text(): string;
}

/** Mount the panel (closed unless it was left open). `table` = the canvas root, shrunk to make room. */
export function mountJsonPanel(app: App, table: HTMLElement, onToggle?: (open: boolean) => void): JsonPanel {
  const store = app.store;
  const session = new JsonSession(store, app.redactors, () => app.viewer);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el('aside', 'jp');
  root.hidden = true;
  root.dataset.testid = 'json-panel';
  const grip = el('div', 'jp-grip');
  const head = el('div', 'jp-head');
  const title = el('span', 'jp-title', 'board.canvas');
  const apply = el('button', 'jp-apply', 'Apply');
  apply.title = 'Apply your edits to the board (⌘S)';
  const reload = el('button', 'jp-reload', 'Reload');
  reload.title = 'Throw away your edits and show the board as it is now';
  const autoLabel = el('label', 'jp-auto');
  const auto = el('input', '');
  auto.type = 'checkbox';
  auto.checked = localStorage.getItem(AUTO_KEY) === '1';
  autoLabel.append(auto, ' Auto');
  autoLabel.title = 'Apply by itself when you pause typing and the JSON is valid';
  const close = el('button', 'jp-close', '×');
  close.title = 'Close';
  head.append(title, apply, reload, autoLabel, close);
  const host = el('div', 'jp-host');
  const status = el('div', 'jp-status');
  root.append(grip, head, host, status);
  document.body.append(root);

  // ---- state
  let from: 'program' | 'user' = 'user'; // 'program' while the panel itself rewrites the text
  let stale = false; // the board changed while I have unapplied edits
  let errorMsg = '';
  let pendingCount = 0;
  let flashMsg = '';
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSel = '';
  let opened = false;

  const dirty = () => view.state.doc.toString() !== session.text;

  const paintStatus = () => {
    const d = dirty();
    apply.disabled = !d || !!errorMsg;
    reload.hidden = !d && !stale;
    reload.classList.toggle('jp-warn', stale);
    root.classList.toggle('jp-invalid', !!errorMsg);
    let msg: string;
    if (flashMsg) msg = flashMsg;
    else if (errorMsg) msg = errorMsg;
    else if (d) msg = `${pendingCount} change${pendingCount === 1 ? '' : 's'} not applied${stale ? ' · the board changed meanwhile: Apply merges, Reload discards' : ''}`;
    else msg = 'In sync with the board';
    status.textContent = msg;
    status.dataset.state = flashMsg ? 'ok' : errorMsg ? 'error' : d ? 'dirty' : 'clean';
  };
  const flash = (msg: string) => {
    flashMsg = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashMsg = '';
      paintStatus();
    }, 3000);
    paintStatus();
  };

  /** Re-check the editor text: errors and how many changes it holds. */
  const validate = () => {
    const text = view.state.doc.toString();
    if (text === session.text) {
      errorMsg = '';
      pendingCount = 0;
    } else {
      const p = session.plan(text);
      if (!p.ok) {
        errorMsg = p.error;
        pendingCount = 0;
      } else {
        errorMsg = '';
        const s = p.summary;
        pendingCount = s.added.length + s.changed.length + s.removed.length + s.edges;
      }
    }
    paintStatus();
  };

  /** Replace the editor text with `text`, touching only the differing middle (keeps caret, scroll, folds around it). */
  const show = (text: string) => {
    const old = view.state.doc.toString();
    if (old === text) return;
    let a = 0;
    const max = Math.min(old.length, text.length);
    while (a < max && old[a] === text[a]) a++;
    let b = 0;
    while (b < max - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    from = 'program';
    view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) } });
    from = 'user';
  };

  const doApply = () => {
    clearTimeout(autoTimer);
    const text = view.state.doc.toString();
    if (text === session.text) return;
    const r = session.apply(text);
    if (!r.ok) {
      errorMsg = r.error;
      paintStatus();
      return;
    }
    stale = false;
    show(r.shown);
    markSelection(false);
    validate();
    flash(r.line ? `Applied: ${r.line}` : 'No changes');
    if (r.line) app.notify(`Applied the JSON: ${r.line.replace('edited the JSON: ', '')}`);
  };

  const doReload = () => {
    clearTimeout(autoTimer);
    stale = false;
    show(session.refresh());
    markSelection(false);
    validate();
  };

  // ---- canvas -> editor
  /** Highlight the selected nodes' blocks; scroll the first into view (unless the editor caused the selection). */
  function markSelection(scroll: boolean) {
    const text = view.state.doc.toString();
    const ids = new Set(store.selection);
    const ranges = ids.size ? blocks(text).filter((b) => b.kind === 'nodes' && ids.has(b.id)) : [];
    const effects: StateEffect<unknown>[] = [setMarks.of(ranges.map((r) => ({ from: r.from, to: r.to })))];
    if (scroll && ranges.length) effects.push(EditorView.scrollIntoView(ranges[0].from, { y: 'start', yMargin: 24 }));
    view.dispatch({ effects });
  }

  /** Follow the board: new text when there are no unapplied edits, a notice when there are; selection marks. */
  const follow = () => {
    if (root.hidden) return;
    const cur = session.current();
    if (cur !== session.text) {
      if (!dirty()) {
        show(session.refresh());
        markSelection(false);
      } else if (!stale) {
        stale = true;
        paintStatus();
      }
    }
    const sel = [...store.selection].sort().join(',');
    if (sel !== lastSel) {
      lastSel = sel;
      markSelection(true);
    }
  };
  app.view.onRender(() => {
    if (root.hidden || followTimer) return;
    followTimer = setTimeout(() => {
      followTimer = undefined;
      follow();
    }, FOLLOW_DELAY);
  });

  // ---- editor -> canvas
  /** Moving the caret into a node's block selects that node on the canvas (and brings it into view). */
  const caretToCanvas = (pos: number) => {
    const id = nodeAt(view.state.doc.toString(), pos);
    if (!id || (store.selection.size === 1 && store.selection.has(id))) return;
    const n = app.node(id);
    if (!n || !store.doc.isVisible(id) || app.isConcealed(n)) return;
    store.select([id]);
    lastSel = [...store.selection].sort().join(',');
    markSelection(false);
    revealOnCanvas(id);
  };
  const revealOnCanvas = (id: string) => {
    const n = app.node(id);
    if (!n) return;
    const r = app.view.root.getBoundingClientRect();
    const vp = app.viewport;
    const sx = n.x * vp.zoom + vp.x;
    const sy = n.y * vp.zoom + vp.y;
    const inside = sx >= 0 && sy >= 0 && sx + n.width * vp.zoom <= r.width && sy + n.height * vp.zoom <= r.height;
    if (!inside) vp.set(r.width / 2 - (n.x + n.width / 2) * vp.zoom, r.height / 2 - (n.y + n.height / 2) * vp.zoom, vp.zoom);
  };

  const extensions: Extension[] = [
    basicSetup,
    json(),
    linter(jsonParseLinter(), { delay: 250 }),
    lintGutter(),
    syntaxHighlighting(highlight),
    theme,
    marks,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          doApply();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && from === 'user') {
        validate();
        clearTimeout(autoTimer);
        if (auto.checked) autoTimer = setTimeout(() => !errorMsg && dirty() && doApply(), AUTO_DELAY);
      }
      if (u.selectionSet && !u.docChanged && u.transactions.some((tr) => tr.isUserEvent('select'))) caretToCanvas(u.state.selection.main.head);
    }),
  ];
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: session.text, extensions }) });

  // ---- chrome
  apply.addEventListener('click', doApply);
  reload.addEventListener('click', doReload);
  auto.addEventListener('change', () => {
    localStorage.setItem(AUTO_KEY, auto.checked ? '1' : '0');
    if (auto.checked && dirty() && !errorMsg) doApply();
  });
  close.addEventListener('click', () => panel.close());
  // keep key presses in the editor out of the canvas' shortcuts (Delete would delete the selected node!)
  for (const type of ['keydown', 'keyup', 'keypress'] as const) root.addEventListener(type, (e) => e.stopPropagation());

  const setWidth = (w: number) => {
    const width = Math.round(Math.min(Math.max(w, 280), window.innerWidth * 0.8));
    root.style.width = `${width}px`;
    if (!root.hidden) table.style.right = `${width}px`;
    localStorage.setItem(WIDTH_KEY, String(width));
  };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  setWidth(Number(localStorage.getItem(WIDTH_KEY)) || 460);

  const panel: JsonPanel = {
    get isOpen() {
      return !root.hidden;
    },
    open() {
      if (!root.hidden) return;
      root.hidden = false;
      table.style.right = root.style.width;
      localStorage.setItem(OPEN_KEY, '1');
      if (!opened || !dirty()) show(session.refresh());
      opened = true;
      markSelection(true);
      validate();
      onToggle?.(true);
    },
    close() {
      if (root.hidden) return;
      root.hidden = true;
      table.style.right = '';
      localStorage.setItem(OPEN_KEY, '0');
      app.view.root.focus();
      onToggle?.(false);
    },
    toggle() {
      if (root.hidden) panel.open();
      else panel.close();
    },
    text: () => view.state.doc.toString(),
  };
  (window as any).jsonPanel = panel;
  paintStatus();
  return panel;
}

/** Whether the panel was left open last time. */
export const jsonPanelWasOpen = () => localStorage.getItem(OPEN_KEY) === '1';
