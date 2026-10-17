import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, ShotArgs, ShotReply } from './client';
import { parseArgv } from './flags';
import { runShot, shotArgsFromCli, shotPath } from './shotCli';

const cli = (line: string) => {
  const { pos, flags } = parseArgv(line.split(' '));
  return shotArgsFromCli(pos.slice(1), flags);
};

describe('canvas screenshot arguments', () => {
  it('node, region, labels, sizes', () => {
    expect(cli('screenshot')).toEqual({});
    expect(cli('screenshot Plan --region 0,0,400,300 --labels --width 800 --height 600 --padding 10')).toEqual({ node: 'Plan', region: { x: 0, y: 0, width: 400, height: 300 }, labels: true, width: 800, height: 600, padding: 10 });
    expect(cli('screenshot --labels false')).toEqual({ labels: false });
    expect(cli('screenshot --region -50,20,400.5,300').region).toEqual({ x: -50, y: 20, width: 400.5, height: 300 });
  });
  it('bad input says what is wrong', () => {
    expect(() => cli('screenshot --region 1,2,3')).toThrow('X,Y,W,H');
    expect(() => cli('screenshot --region a,b,c,d')).toThrow('not a number');
    expect(() => cli('screenshot --width wide')).toThrow('not a number');
    expect(() => cli('screenshot --labels Plan')).toThrow('put the node before');
    expect(() => cli('screenshot a b')).toThrow('one node only');
    expect(() => cli('screenshot --frobnicate 1')).toThrow('unknown flag --frobnicate');
  });
  it('the default path is under the temp folder, named by board and time', () => {
    const p = shotPath({ canvas: 'my board' }, new Date('2026-10-16T10:11:12.345Z'));
    expect(p).toBe(join(tmpdir(), 'canvas-shots', 'my_board-2026-10-16T10-11-12-345Z.png'));
    expect(shotPath({ out: '/x/y.png' })).toBe('/x/y.png');
    expect(shotPath({})).toContain('bridge-');
  });
});

describe('runShot', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('writes the PNG from base64, prints path and size, lists ids with --labels', async () => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-shotcli-'));
    const asked: ShotArgs[] = [];
    const reply: ShotReply = { png: Buffer.from([137, 80, 78, 71, 9]).toString('base64'), mime: 'image/png', seat: 'agent:claude', target: 'whole canvas', width: 1000, height: 750, ms: 88, nodes: [{ id: 'n1', type: 'text', box: [1, 2, 3, 4] }] };
    const c = { shot: async (a: ShotArgs) => (asked.push(a), reply) } as unknown as Client;
    const out = join(dir, 'sub', 's.png');
    const lines: string[] = [];
    await runShot(c, [], { out, labels: 'true' }, (l) => lines.push(l));
    expect(asked).toEqual([{ labels: true }]);
    expect([...readFileSync(out)]).toEqual([137, 80, 78, 71, 9]);
    expect(lines[0]).toContain(out);
    expect(lines[0]).toContain('1000x750');
    expect(lines[0]).toContain('88 ms');
    expect(lines[1]).toMatch(/^n1\s+text\s+\[1,2,3,4\]$/);
    const json: string[] = [];
    await runShot(c, [], { out, json: 'true' }, (l) => json.push(l));
    expect(JSON.parse(json[0])).toMatchObject({ path: out, width: 1000, nodes: [{ id: 'n1' }] });
    expect(json[0]).not.toContain('"png"');
  });
});
