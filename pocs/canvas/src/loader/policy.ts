import type { CanvasNode, Change, DocView } from '../core';
import type { EventSpec } from '../core';
import { has, type Manifest } from './manifest';

// The capability checks of the bridge: what a sandboxed plugin may see, and which of the changes it
// returns may be applied. Pure functions over plain data (tested without a browser).

/** Core fields a plugin may write on its own nodes (plus its whole `x-<id>` namespace). */
export const WRITABLE = new Set(['x', 'y', 'width', 'height', 'text', 'color', 'label']);
/** Fields a plugin's new node may carry. */
const ADDABLE = new Set([...WRITABLE, 'id', 'type', 'z']);
const MAX_CHANGES = 500;
const MAX_NODE_BYTES = 16_000;

export const nsOf = (m: Pick<Manifest, 'id'>) => `x-${m.id}` as const;
/** Does the plugin own this node (it carries the plugin's namespace)? */
export const owns = (m: Pick<Manifest, 'id'>, n: CanvasNode | undefined) => !!n && n[nsOf(m)] !== undefined;

/** A plain node a plugin may see: geometry only for a node hidden from the viewer. */
function redact(n: CanvasNode): CanvasNode {
  return { id: n.id, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height, z: n.z, 'x-redacted': true };
}

/**
 * The part of the doc a plugin may read, as plain data (it crosses the bridge by structured clone).
 * Own nodes always; other nodes only with `nodes:read:all`, and those hidden from the local viewer
 * (another player's hand) come redacted: the sandbox never holds what this screen can't show.
 */
export function readableDoc(m: Manifest, doc: DocView, hidden: (n: CanvasNode) => boolean): { nodes: CanvasNode[] } {
  const all = has(m, 'nodes:read:all');
  const nodes: CanvasNode[] = [];
  for (const n of doc.nodes) {
    if (owns(m, n)) nodes.push(n);
    else if (all) nodes.push(hidden(n) ? redact(n) : n);
  }
  return { nodes: structuredClone(nodes) };
}

export interface PluginResult {
  changes?: Change[];
  events?: EventSpec[];
  select?: string[];
}

export interface Checked {
  changes: Change[];
  events: EventSpec[];
  select?: string[];
  /** Why parts were refused (empty = all allowed). Any denial refuses the whole result. */
  denied: string[];
}

/**
 * Check a plugin's result against its capabilities and the current doc. All or nothing: one denied
 * change drops the whole result (a half-applied command is worse than none).
 */
export function checkResult(m: Manifest, doc: DocView, raw: unknown): Checked {
  const denied: string[] = [];
  const r = (raw && typeof raw === 'object' ? raw : {}) as PluginResult;
  const changes = Array.isArray(r.changes) ? r.changes : [];
  const events = Array.isArray(r.events) ? r.events : [];
  const ns = nsOf(m);
  if (changes.length > MAX_CHANGES) denied.push(`too many changes (${changes.length} > ${MAX_CHANGES})`);
  if (changes.length && !has(m, 'nodes:write')) denied.push('changes need nodes:write');
  const added = new Set<string>();
  for (const c of changes.slice(0, MAX_CHANGES)) {
    if (!c || typeof c !== 'object') {
      denied.push('malformed change');
      continue;
    }
    if (c.op === 'add') {
      const n = c.node;
      if (!n || typeof n.id !== 'string' || ![n.x, n.y, n.width, n.height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        denied.push('add: malformed node');
        continue;
      }
      if (doc.get(n.id)) denied.push(`add ${n.id}: id already exists`);
      if (n[ns] === undefined || typeof n[ns] !== 'object') denied.push(`add ${n.id}: a new node must carry ${ns}`);
      for (const k of Object.keys(n)) if (k !== ns && !ADDABLE.has(k)) denied.push(`add ${n.id}: field "${k}" not allowed`);
      if (JSON.stringify(n).length > MAX_NODE_BYTES) denied.push(`add ${n.id}: node too large`);
      added.add(n.id);
    } else if (c.op === 'set') {
      const target = doc.get(c.id);
      if (!owns(m, target) && !added.has(c.id)) {
        denied.push(`set ${c.id}.${c.key}: not this plugin's node`);
        continue;
      }
      const top = typeof c.key === 'string' ? c.key.split('.')[0] : '';
      if (top !== ns && !WRITABLE.has(top)) denied.push(`set ${c.id}.${c.key}: field not writable`);
    } else if (c.op === 'del') {
      if (!owns(m, doc.get(c.id)) && !added.has(c.id)) denied.push(`del ${c.id}: not this plugin's node`);
    } else denied.push('unknown change op');
  }
  const cleanEvents: EventSpec[] = [];
  if (events.length && !has(m, 'log:write')) denied.push('events need log:write');
  for (const e of events.slice(0, 20)) {
    if (!e || typeof e.type !== 'string' || typeof e.text !== 'string') {
      denied.push('malformed event');
      continue;
    }
    if (!e.type.startsWith(`${m.id}.`)) denied.push(`event type "${e.type}" must start with "${m.id}."`);
    // no impersonation: the actor is always whoever ran the command on this device
    const { actor: _a, ...rest } = e;
    cleanEvents.push({ ...rest, text: e.text.slice(0, 200) });
  }
  const select = Array.isArray(r.select) ? r.select.filter((id) => typeof id === 'string' && (owns(m, doc.get(id)) || added.has(id))) : undefined;
  if (denied.length) return { changes: [], events: [], denied };
  return { changes, events: cleanEvents, select, denied };
}
