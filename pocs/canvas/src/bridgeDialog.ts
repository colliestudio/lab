import { parseBridgeAddress, type BridgeAddress } from './core';
import { forgetBridge, savedBridges } from './bridges';
import { copyText } from './share';

// The "Bridge…" dialog: the one place for bridges in the app.
//  - connected to a bridge: which one, its health, Disconnect
//  - in a room: how to bring agents into it (the command to give an agent) and whether a bridge is there
//  - always: paste a bridge address or link to connect, and the ones used before
// A bridge hosts one .canvas file and its agents (see ideas/bridge-ux.md).

export interface BridgeDialogContext {
  /** This tab is on a bridge. */
  active?: { url: string; online(): boolean; players(): number; disconnect(): void };
  /** This tab is in a room. */
  room?: { id: string; link: string; bridge(): 'none' | 'connecting' | 'online'; agents(): string[] };
  /** Open this bridge in the tab (leaves the room or bridge it is on). */
  connect(address: BridgeAddress): void;
  notify(msg: string): void;
}

let open: HTMLElement | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function agentCommand(roomLink: string, file = '/tmp/canvas-room.canvas') {
  return `pnpm bridge join '${roomLink}' ${file}`;
}

export function openBridgeDialog(ctx: BridgeDialogContext) {
  open?.remove();
  const overlay = el('div', 'name-overlay');
  const dlg = el('div', 'name-dialog bridge-dialog');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.append(el('h2', undefined, 'Bridge'));
  overlay.append(dlg);

  const live: (() => void)[] = [];
  const section = (title: string, hint?: string) => {
    const s = el('section', 'bridge-section');
    s.append(el('h3', undefined, title));
    if (hint) s.append(el('p', 'bridge-hint', hint));
    dlg.append(s);
    return s;
  };
  const button = (label: string, run: () => void, cls = 'bridge-btn') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  };

  if (ctx.active) {
    const a = ctx.active;
    const s = section('Connected');
    const row = el('div', 'bridge-row');
    const state = el('span', 'bridge-state');
    row.append(el('code', undefined, a.url), state, button('Disconnect', () => (close(), a.disconnect())));
    s.append(row);
    live.push(() => {
      const on = a.online();
      state.dataset.ok = String(on);
      state.textContent = on ? `online · ${a.players() + 1} here` : 'offline · retrying';
    });
  }

  if (ctx.room) {
    const r = ctx.room;
    const s = section('Agents in this room', 'A bridge joins this room as one more player and brings agents in: their cursors, chat and edits show up here for everyone, and it saves the board to a .canvas file.');
    const state = el('p', 'bridge-state');
    const cmd = el('code', 'bridge-cmd', agentCommand(r.link));
    s.append(state, el('p', 'bridge-hint', 'Ask your agent to run this in the canvas repo, on the machine it works on:'), cmd, button('Copy command', async () => ctx.notify((await copyText(agentCommand(r.link))) ? 'Command copied' : 'Select the command and copy it')));
    live.push(() => {
      const b = r.bridge();
      const agents = r.agents();
      state.dataset.ok = String(b === 'online');
      state.textContent = b === 'none' ? 'No bridge here yet.' : b === 'connecting' ? 'A bridge is in the room · connecting…' : `Bridge connected${agents.length ? ` · ${agents.join(', ')}` : ''}`;
    });
  }

  const s = section('Connect to a bridge', ctx.room ? 'Opens its board in this tab and leaves the room.' : 'Paste the address or the link the bridge printed. Opens its board in this tab.');
  const form = el('form', 'bridge-form');
  const input = el('input');
  input.placeholder = 'wss://….trycloudflare.com  or  localhost:5222';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Bridge address');
  const error = el('p', 'bridge-error');
  const go = el('button', 'name-ok', 'Connect');
  go.type = 'submit';
  go.style.background = '#2f7d55';
  form.append(input, go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const addr = parseBridgeAddress(input.value);
      close();
      ctx.connect(addr);
    } catch (err) {
      error.textContent = (err as Error).message;
    }
  });
  s.append(form, error);

  const list = el('ul', 'bridge-list');
  const drawList = () => {
    list.replaceChildren(
      ...savedBridges().map((b) => {
        const li = el('li', 'bridge-row');
        const name = el('span', 'bridge-name', b.url.replace(/^wss?:\/\//, ''));
        name.title = `${b.url}${b.token ? ' (with token)' : ''} · last ${new Date(b.last).toLocaleString()}`;
        li.append(name, button('Connect', () => (close(), ctx.connect(b))), button('Forget', () => (forgetBridge(b.url), drawList()), 'bridge-btn quiet'));
        return li;
      }),
    );
    list.hidden = !list.children.length;
  };
  drawList();
  s.append(list);

  const tick = () => live.forEach((f) => f());
  tick();
  const timer = setInterval(tick, 700);
  const close = () => {
    clearInterval(timer);
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (open === overlay) open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  window.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  open = overlay;
  input.focus();
}
