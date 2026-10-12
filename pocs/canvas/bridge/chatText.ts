import type { ChatMessage } from '../src/core/chat';
import { chatLine } from '../src/core/chat';
import type { Client } from './client';
import { titleOf } from './query';

/** Messages as text lines for a terminal or an agent, naming the nodes they point at (by title). */
export async function chatText(c: Client, msgs: ChatMessage[]): Promise<string> {
  if (!msgs.length) return '';
  const titles = new Map<string, string>();
  if (msgs.some((m) => m.node)) for (const n of (await c.doc()).nodes) titles.set(n.id, titleOf(n) || n.id);
  return msgs.map((m) => chatLine(m, m.node ? (titles.get(m.node) ?? `${m.node} (removed)`) : undefined)).join('\n');
}
