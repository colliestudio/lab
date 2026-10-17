import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client, ShotArgs } from './client';

// `canvas screenshot [NODE] [--region X,Y,W,H] [--labels] [--width W] [--height H] [--padding P] [--out FILE]`

export const SHOT_USAGE = 'screenshot [NODE] [--region X,Y,W,H] [--labels] [--width W] [--height H] [--padding P] [--out FILE]';

const number = (flag: string, raw: string) => {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`--${flag}: "${raw}" is not a number`);
  return n;
};

/** The command line to the tool's arguments. NODE goes before the flags (a flag takes the word after it as its value). */
export function shotArgsFromCli(words: string[], flags: Record<string, string>): ShotArgs {
  const known = new Set(['region', 'labels', 'width', 'height', 'padding', 'out', 'as', 'bridge', 'canvas', 'json']);
  const bad = Object.keys(flags).find((f) => !known.has(f));
  if (bad) throw new Error(`screenshot: unknown flag --${bad}\nusage: ${SHOT_USAGE}`);
  if (words.length > 1) throw new Error(`screenshot: one node only, got: ${words.join(' ')}\nusage: ${SHOT_USAGE}`);
  if (flags.labels !== undefined && flags.labels !== 'true' && flags.labels !== 'false') throw new Error(`--labels takes no value; put the node before the flags: screenshot "${flags.labels}" --labels`);
  const out: ShotArgs = {};
  if (words[0] !== undefined) out.node = words[0];
  if (flags.region !== undefined) {
    const p = flags.region.split(',').map((s) => number('region', s));
    if (p.length !== 4) throw new Error('--region takes X,Y,W,H in canvas coordinates, e.g. --region 0,0,800,600');
    out.region = { x: p[0], y: p[1], width: p[2], height: p[3] };
  }
  if (flags.labels !== undefined) out.labels = flags.labels === 'true';
  for (const k of ['width', 'height', 'padding'] as const) if (flags[k] !== undefined) out[k] = number(k, flags[k]);
  return out;
}

/** Where the PNG goes: --out, else $TMPDIR/canvas-shots/<board or "bridge">-<time>.png. */
export function shotPath(flags: Record<string, string>, now = new Date()): string {
  if (flags.out) return flags.out;
  return join(tmpdir(), 'canvas-shots', `${(flags.canvas ?? 'bridge').replace(/[^\w.-]+/g, '_')}-${now.toISOString().replace(/[:.]/g, '-')}.png`);
}

/** Take the shot, write the PNG and say where it went (with the ids in view when labelled). */
export async function runShot(c: Client, words: string[], flags: Record<string, string>, say: (line: string) => void, now = new Date()): Promise<string> {
  const args = shotArgsFromCli(words, flags);
  const r = await c.shot(args);
  const path = shotPath(flags, now);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(r.png, 'base64'));
  if (flags.json) {
    const { png: _png, ...meta } = r;
    say(JSON.stringify({ path, ...meta }, null, 2));
  } else {
    say(`${path}  ${r.width}x${r.height}  ${r.ms} ms  (${r.target} as ${r.seat})`);
    if (args.labels) for (const n of r.nodes) say(`${n.id.padEnd(18)} ${n.type.padEnd(8)} [${n.box.join(',')}]`);
  }
  return path;
}
