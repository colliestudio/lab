import type * as Y from 'yjs';
import type { CanvasNode } from './doc';
import { titleOf } from './query';

// Table chat: a text conversation next to the board, for everyone seated (people in browsers,
// agents and tools through the bridge). DOM-free, so the bridge and tests use it too.
//
// Messages live in a synced Y.Array in the doc (like the event log), capped. That makes them work
// over every transport the doc already has (WebRTC mesh, bridge WebSocket), gives late joiners the
// recent history, and survives reloads (IndexedDB / the bridge's state sidecar). They are not
// commands (no undo, not in the event log) and not part of the .canvas file (see ideas/chat.md).

export interface ChatFrom {
  id: string;
  name: string;
  color: string;
  /** Set for agents and tools seated through the bridge; people leave it out. */
  kind?: 'agent' | 'tool';
}

export interface ChatMessage {
  id: string;
  /** ms epoch on the sender's device. */
  time: number;
  from: ChatFrom;
  text: string;
  /** A node this message is about (click to jump there). */
  node?: string;
}

/** Keep this many messages (oldest go). */
export const CHAT_CAP = 300;
/** Longest message text (longer is cut). */
export const CHAT_MAX_TEXT = 2000;

export const chatArray = (ydoc: Y.Doc) => ydoc.getArray<ChatMessage>('chat');

let counter = 0;
const newId = () => `m${Date.now().toString(36)}${(counter++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Append a message (one transaction, not undoable). Returns it, or null for an empty text. */
export function sendChat(ydoc: Y.Doc, from: ChatFrom, text: string, opts: { node?: string; now?: number } = {}): ChatMessage | null {
  const body = text.trim().slice(0, CHAT_MAX_TEXT);
  if (!body) return null;
  const msg: ChatMessage = {
    id: newId(),
    time: opts.now ?? Date.now(),
    from: { id: from.id, name: from.name, color: from.color, ...(from.kind ? { kind: from.kind } : {}) },
    text: body,
    ...(opts.node ? { node: opts.node } : {}),
  };
  const arr = chatArray(ydoc);
  ydoc.transact(() => {
    arr.push([msg]);
    const over = arr.length - CHAT_CAP;
    if (over > 0) arr.delete(0, over);
  }, 'chat');
  return msg;
}

/** Messages after `seenId`. Unknown id (never seen, or capped away) = all of them. */
export function after(messages: readonly ChatMessage[], seenId: string | undefined): ChatMessage[] {
  if (!seenId) return messages.slice();
  const i = messages.findIndex((m) => m.id === seenId);
  return messages.slice(i + 1);
}

/** What a reader hasn't seen: messages after `seenId` that someone else wrote. */
export const unread = (messages: readonly ChatMessage[], seenId: string | undefined, me: string) => after(messages, seenId).filter((m) => m.from.id !== me);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` @-mention this name (or everyone: @all)? Case-insensitive; the name may contain spaces. */
export function mentions(text: string, name: string): boolean {
  if (/(^|[\s(])@(all|everyone)(?![\w-])/i.test(text)) return true;
  const n = name.trim();
  return !!n && new RegExp(`(^|[\\s(])@${esc(n)}(?![\\w-])`, 'i').test(text);
}

/** Split text into plain and @-mention parts for the names given (longest names win). */
export function splitMentions(text: string, names: readonly string[]): { text: string; mention?: string }[] {
  const all = [...new Set([...names.map((n) => n.trim()).filter(Boolean), 'all', 'everyone'])].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(^|[\\s(])@(${all.map(esc).join('|')})(?![\\w-])`, 'gi');
  const out: { text: string; mention?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `@${m[2]}`, mention: m[2] });
    last = start + 1 + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** One line for a terminal or an agent: "[12:03] Alice: hello  (re: Deck)". */
export function chatLine(m: ChatMessage, nodeTitle?: string): string {
  const d = new Date(m.time); // local time, like the panel
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const tag = m.from.kind ? ` (${m.from.kind})` : '';
  return `[${t}] ${m.from.name}${tag}: ${m.text}${m.node ? `  (re: ${nodeTitle ?? m.node})` : ''}`;
}

/**
 * Drop malformed entries: any peer can write to the array, so readers check what senders promise
 * (a time `Date` can format, text within the limit, a sender with id, name and color).
 */
export const validMessage = (m: unknown): m is ChatMessage => {
  const x = m as ChatMessage;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.text === 'string' &&
    x.text.length <= CHAT_MAX_TEXT &&
    Number.isFinite(x.time) &&
    Math.abs(x.time) <= 8.64e15 &&
    !!x.from &&
    typeof x.from.id === 'string' &&
    typeof x.from.name === 'string' &&
    typeof x.from.color === 'string' &&
    (x.node === undefined || typeof x.node === 'string')
  );
};

/** The well-formed messages, oldest first. */
export const chatMessages = (ydoc: Y.Doc) => chatArray(ydoc).toArray().filter(validMessage);

/** Messages as text lines for a terminal or an agent, naming the nodes they point at (by title). */
export function chatText(msgs: ChatMessage[], doc: { nodes: readonly CanvasNode[] }): string {
  const titles = new Map<string, string>();
  if (msgs.some((m) => m.node)) for (const n of doc.nodes) titles.set(n.id, titleOf(n) || n.id);
  return msgs.map((m) => chatLine(m, m.node ? (titles.get(m.node) ?? `${m.node} (removed)`) : undefined)).join('\n');
}
