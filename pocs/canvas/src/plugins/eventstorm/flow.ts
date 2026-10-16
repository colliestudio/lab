import type { CanvasNode, DocView } from '../../core';
import { attachedTo, eventsOn, stickiesOn } from './commands';
import { FLOW } from './markdown';
import { KIND_ORDER, center, isEvent, kindOf, laneAt, lanesOf, offered, phaseOf, sticky, type Phase, type StickyKind } from './model';

// The storm as data and as text for agents: the timeline in order with ids, lanes and what is
// attached, what is loose, and the next step. Node-safe (no DOM).

export interface FlowSticky {
  id: string;
  kind: StickyKind;
  text: string;
}
export interface FlowEvent {
  /** 1-based place on the timeline. */
  n: number;
  id: string;
  text: string;
  lane: string;
  attached: FlowSticky[];
}
export interface StormFlow {
  board: { id: string; label: string; phase: Phase; offers: StickyKind[]; lanes: string[] };
  events: FlowEvent[];
  loose: (FlowSticky & { lane: string })[];
  next?: string;
}

const words = (n: CanvasNode) => (n.text ?? '').trim().replace(/\s*\n\s*/g, ' / ') || '(empty)';
const brief = (n: CanvasNode): FlowSticky => ({ id: n.id, kind: kindOf(n), text: words(n) });

function nextStep(phase: Phase, events: FlowEvent[]): string | undefined {
  if (phase === 'explore') return events.length ? 'switch to timeline (storm.phase {phase:"timeline"}) to put the events in order.' : undefined;
  if (phase === 'timeline') return 'storm.phase {phase:"process"} to add commands, actors and policies.';
  if (phase === 'process') {
    const bare = events.filter((e) => !e.attached.some((s) => s.kind === 'command'));
    if (bare.length) return `${bare.length} event${bare.length === 1 ? ' has' : 's have'} no command yet: ${bare.map((e) => e.text).join(', ')}.`;
  }
}

export function flowOf(doc: DocView, b: CanvasNode): StormFlow {
  const lanes = lanesOf(b);
  const laneName = (n: CanvasNode) => lanes[laneAt(b, center(n).y)];
  const phase = phaseOf(b);
  const events: FlowEvent[] = eventsOn(doc, b.id).map((ev, i) => {
    const att = attachedTo(doc, ev.id);
    return { n: i + 1, id: ev.id, text: words(ev), lane: laneName(ev), attached: FLOW.flatMap((k) => att.filter((s) => kindOf(s) === k).map(brief)) };
  });
  const loose = stickiesOn(doc, b.id)
    .filter((n) => !isEvent(n) && !sticky(n).on)
    .sort((p, q) => KIND_ORDER.indexOf(kindOf(p)) - KIND_ORDER.indexOf(kindOf(q)))
    .map((n) => ({ ...brief(n), lane: laneName(n) }));
  const next = nextStep(phase, events);
  return { board: { id: b.id, label: b.label ?? 'Event storm', phase, offers: offered(phase), lanes }, events, loose, ...(next ? { next } : {}) };
}

/** "1-2,4" for the numbers in `ns` (ascending). */
function ranges(ns: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (ns[j + 1] === ns[j] + 1) j++;
    out.push(j > i ? `${ns[i]}-${ns[j]}` : `${ns[i]}`);
    i = j + 1;
  }
  return out.join(',');
}

export function flowText(f: StormFlow): string {
  const { board: b } = f;
  const multi = b.lanes.length > 1;
  const tag = (lane: string) => (multi ? ` [${lane}]` : '');
  const lines = [`Event storm “${b.label}” (${b.id}) · phase ${b.phase} · offers ${b.offers.join(', ')}`, `Lanes: ${b.lanes.join(' | ')}`, ''];
  if (!f.events.length) lines.push('Timeline: none yet. Add events with storm.add {kind:"event", text}.');
  else {
    lines.push('Timeline, left to right:');
    for (const e of f.events) {
      lines.push(`${String(e.n).padStart(2)}. ${e.text} (${e.id})${tag(e.lane)}`);
      for (const s of e.attached) lines.push(`      ${s.kind}: ${s.text} (${s.id})`);
    }
    if (multi) {
      const by = b.lanes.map((l) => [l, ranges(f.events.filter((e) => e.lane === l).map((e) => e.n))] as const).filter(([, r]) => r);
      lines.push(`By lane: ${by.map(([l, r]) => `${l} ${r}`).join(' · ')}`);
    }
  }
  if (f.loose.length) {
    lines.push('', 'Not on an event:');
    for (const s of f.loose) lines.push(`  ${s.kind}: ${s.text} (${s.id})${tag(s.lane)}`);
  }
  if (f.next) lines.push('', `Next: ${f.next}`);
  return lines.join('\n');
}
