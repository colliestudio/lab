import type { CanvasNode, DocView } from '../../core';
import { attachedTo, eventsOn, stickiesOn } from './commands';
import { KINDS, KIND_ORDER, PHASE_INFO, center, isEvent, kindOf, laneAt, lanesOf, phaseOf, sticky, voteTotal, type StickyKind } from './model';

// The flow as Markdown, for people and agents: the events in timeline order, each with what is
// attached to it (what triggers it above, what follows below), then whatever isn't on the
// timeline yet. Plain text only: no ids, no coordinates.

const words = (n: CanvasNode) => (n.text ?? '').trim().replace(/\s*\n\s*/g, ' / ') || '(empty)';
const extras = (n: CanvasNode, withAuthor: boolean) => {
  const out: string[] = [];
  const v = voteTotal(n);
  if (v) out.push(`${v} vote${v === 1 ? '' : 's'}`);
  const by = sticky(n).by;
  if (withAuthor && by) out.push(`by ${by.name}`);
  return out.length ? ` _(${out.join(', ')})_` : '';
};
/** Above the event first, in the order a reader follows the flow: actor → command → aggregate → event → policy / read model / external. */
export const FLOW: StickyKind[] = ['actor', 'command', 'aggregate', 'external', 'read', 'policy', 'hotspot'];

export function toMarkdown(doc: DocView, b: CanvasNode, o: { authors?: boolean } = {}): string {
  const authors = o.authors ?? true;
  const lanes = lanesOf(b);
  const lines: string[] = [`# Event storm: ${b.label ?? 'Event storm'}`, ''];
  lines.push(`Phase: ${PHASE_INFO[phaseOf(b)].name.replace(/^\d /, '')}. ${lanes.length > 1 ? `Lanes: ${lanes.join(', ')}.` : ''}`.trim(), '');
  const evs = eventsOn(doc, b.id);
  lines.push('## Timeline', '');
  if (!evs.length) lines.push('_No domain events yet._', '');
  evs.forEach((ev, i) => {
    const lane = lanes.length > 1 ? ` [${lanes[laneAt(b, center(ev).y)]}]` : '';
    lines.push(`${i + 1}. **${words(ev)}**${lane}${extras(ev, authors)}`);
    const att = attachedTo(doc, ev.id);
    for (const k of FLOW) for (const s of att.filter((s) => kindOf(s) === k)) lines.push(`   - ${KINDS[k].name}: ${words(s)}${extras(s, authors)}`);
  });
  if (evs.length) lines.push('');
  const loose = stickiesOn(doc, b.id).filter((n) => !isEvent(n) && !sticky(n).on);
  for (const k of KIND_ORDER) {
    const l = loose.filter((n) => kindOf(n) === k);
    if (!l.length) continue;
    lines.push(`## ${KINDS[k].plural} not on an event`, '', ...l.map((n) => `- ${words(n)}${extras(n, authors)}`), '');
  }
  const voted = stickiesOn(doc, b.id)
    .filter((n) => voteTotal(n) > 0)
    .sort((p, q) => voteTotal(q) - voteTotal(p));
  if (voted.length) lines.push('## Most votes', '', ...voted.slice(0, 5).map((n) => `- ${voteTotal(n)}: ${words(n)} (${KINDS[kindOf(n)].name.toLowerCase()})`), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
