import type * as Y from 'yjs';
import type { App } from './app';
import { chatArray, chatMessages, mentions, sendChat, splitMentions, unread, validMessage, type ChatMessage } from './chat';
import { anchorOf, jumpTo } from './logView';
import { ago } from './log';

// The chat panel: a toolbar button with an unread badge, a panel on the right with the messages
// (attributed, colored), an input, and a way to point a message at a node. Everything it shows
// comes from the synced chat array (chat.ts), so it works over any transport the doc has.

/** New messages older than this (history arriving from another device) don't pop a notice. */
const FRESH_MS = 15_000;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** `key` names this table for the "last read" memory (room id or bridge url). */
export function mountChat(app: App, bar: HTMLElement, key: string, parent: HTMLElement = document.body) {
  const arr = chatArray(app.store.ydoc);
  const SEEN_KEY = `canvas-poc:chat-seen:${key}`;
  const OPEN_KEY = 'canvas-poc:chat-open';
  const store = (k: string, v?: string) => {
    try {
      if (v === undefined) return localStorage.getItem(k) ?? undefined;
      localStorage.setItem(k, v);
    } catch {
      /* no storage */
    }
  };
  const me = () => app.me();
  const msgs = () => chatMessages(app.store.ydoc);

  // ---- toolbar button
  const btn = el('button', 'chat-btn', 'Chat');
  btn.title = 'Chat with everyone at the table (⇧C)';
  const badge = el('span', 'chat-badge');
  btn.append(badge);
  const anchor = bar.querySelector('.help-btn');
  if (anchor) anchor.before(btn);
  else bar.append(btn);

  // ---- panel
  const panel = el('div', 'cv-chat');
  panel.hidden = true;
  const head = el('div', 'cv-chat-head');
  head.append(el('span', 'cv-chat-title', 'Chat'));
  const close = el('button', 'cv-chat-close', '×');
  close.title = 'Close (Esc)';
  head.append(close);
  const list = el('ol', 'cv-chat-list');
  const form = el('form', 'cv-chat-form');
  const chip = el('span', 'cv-chat-attach');
  chip.hidden = true;
  const input = el('textarea', 'cv-chat-input');
  input.rows = 1;
  input.maxLength = 2000;
  input.placeholder = 'Say something…';
  const attachBtn = el('button', 'cv-chat-pin', '📍︎');
  attachBtn.type = 'button';
  attachBtn.title = 'Point this message at the selected node';
  const send = el('button', 'cv-chat-send', 'Send');
  send.type = 'submit';
  const row = el('div', 'cv-chat-row');
  row.append(attachBtn, input, send);
  form.append(chip, row);
  panel.append(head, list, form);
  parent.append(panel);

  let open = false;
  let attached: string | undefined;
  /** Last message the local player has seen (this device, this table). */
  let seenId = store(SEEN_KEY) || undefined;

  const titleOf = (id: string) => {
    const n = app.node(id);
    if (!n) return undefined;
    return (n.label ?? n.text ?? n.type).split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 40) || n.type;
  };

  const names = () => [me().name, ...(app.presence?.peers().map((p) => p.name) ?? [])];

  const renderBadge = () => {
    const un = open ? [] : unread(msgs(), seenId, me().id);
    badge.hidden = un.length === 0;
    badge.textContent = un.length > 99 ? '99+' : String(un.length);
    badge.classList.toggle('chat-badge-mention', un.some((m) => mentions(m.text, me().name)));
  };

  const renderAttach = () => {
    const t = attached && titleOf(attached);
    if (!attached || !t) {
      attached = undefined;
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.replaceChildren(el('span', '', `📍 ${t}`));
    const x = el('button', '', '×');
    x.type = 'button';
    x.title = 'Remove';
    x.addEventListener('click', () => {
      attached = undefined;
      renderAttach();
    });
    chip.append(x);
  };

  const renderList = () => {
    if (!open) return;
    const pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    const now = Date.now();
    const all = msgs();
    const known = names();
    list.replaceChildren(
      ...all.map((m) => {
        const mine = m.from.id === me().id;
        const li = el('li', 'cv-chat-msg');
        li.dataset.id = m.id;
        if (mine) li.classList.add('cv-chat-mine');
        if (!mine && mentions(m.text, me().name)) li.classList.add('cv-chat-mentioned');
        const who = el('button', 'cv-chat-who', mine ? 'You' : m.from.name);
        who.type = 'button';
        who.style.setProperty('--cv-actor', m.from.color);
        who.dataset.name = m.from.name;
        if (!mine) who.title = `Mention ${m.from.name}`;
        const meta = el('span', 'cv-chat-meta');
        if (m.from.kind) meta.append(el('span', 'cv-chat-kind', m.from.kind));
        const t = el('time', 'cv-chat-time', ago(now - m.time));
        t.title = new Date(m.time).toLocaleString();
        meta.append(t);
        const body = el('div', 'cv-chat-text');
        for (const part of splitMentions(m.text, known)) {
          if (part.mention) body.append(el('span', mentions(part.text, me().name) ? 'cv-chat-at cv-chat-at-me' : 'cv-chat-at', part.text));
          else body.append(document.createTextNode(part.text));
        }
        li.append(who, meta, body);
        if (m.node) {
          const title = titleOf(m.node);
          const ref = el('button', 'cv-chat-ref', title ? `📍 ${title}` : '📍 (removed)');
          ref.type = 'button';
          ref.dataset.node = m.node;
          if (!title || !anchorOf(app, { targets: [m.node] })) ref.disabled = true;
          li.append(ref);
        }
        return li;
      }),
    );
    if (!all.length) list.append(el('li', 'cv-chat-empty', 'No messages yet. Agents at the table can chat too.'));
    if (pinned) list.scrollTop = list.scrollHeight;
  };

  const markSeen = () => {
    seenId = msgs().at(-1)?.id;
    if (seenId) store(SEEN_KEY, seenId);
  };

  const setOpen = (v: boolean, focus = false) => {
    open = v;
    panel.hidden = !v;
    btn.classList.toggle('active', v);
    store(OPEN_KEY, v ? '1' : '0');
    if (v) {
      markSeen();
      renderList();
      list.scrollTop = list.scrollHeight;
      if (focus) input.focus();
    }
    renderBadge();
  };
  const toggle = () => setOpen(!open, true);
  btn.addEventListener('click', toggle);
  close.addEventListener('click', () => setOpen(false));

  // ---- sending
  const submit = () => {
    const m = sendChat(app.store.ydoc, { id: me().id, name: me().name, color: me().color }, input.value, { node: attached });
    if (!m) return;
    input.value = '';
    attached = undefined;
    renderAttach();
    input.style.height = '';
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing is not a table shortcut
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      input.blur();
      setOpen(false);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
  });
  attachBtn.addEventListener('click', () => {
    const sel = app.selected().find((n) => !app.isConcealed(n) && !app.hiddenFrom(n));
    if (!sel) return app.notify('Select a node first, then click 📍 to point the message at it');
    attached = sel.id;
    renderAttach();
    input.focus();
  });
  list.addEventListener('click', (ev) => {
    const t = ev.target as Element;
    const ref = t.closest<HTMLElement>('.cv-chat-ref');
    if (ref?.dataset.node) {
      const n = app.node(ref.dataset.node);
      if (n) jumpTo(app, n);
      return;
    }
    const who = t.closest<HTMLElement>('.cv-chat-who');
    if (who?.dataset.name && who.textContent !== 'You') {
      input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? ' ' : ''}@${who.dataset.name} `;
      input.focus();
    }
  });

  // ---- incoming
  arr.observe((ev: Y.YArrayEvent<ChatMessage>) => {
    const now = Date.now();
    const added: ChatMessage[] = [];
    for (const d of ev.changes.delta) if (d.insert) added.push(...(d.insert as ChatMessage[]));
    if (open) markSeen();
    else
      for (const m of added.filter(validMessage)) {
        if (m.from.id === me().id || Math.abs(now - m.time) > FRESH_MS) continue;
        app.notify(`${m.from.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    renderList();
    renderBadge();
  });
  app.store.subscribe(() => {
    if (open && attached) renderAttach();
  });
  setInterval(() => open && renderList(), 15_000);
  app.registerKey({ key: 'shift+c', label: 'Chat', run: toggle });
  if (store(OPEN_KEY) === '1') setOpen(true);
  else renderBadge();
  return { toggle, setOpen, panel, button: btn };
}
