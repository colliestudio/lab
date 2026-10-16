import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';

// The bridge names no plugin: what plugins can do arrives through their descriptions (the catalog).
// A plugin's name or command in bridge code means a plugin got special treatment the others can't have.

const dir = __dirname;
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !/\.test(-util)?\.ts$/.test(f));
// comments are not code: strip them before looking for names
const code = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('bridge/ stays generic', () => {
  it('imports no plugin but the list and the CLI extras', () => {
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+'([^']*src\/plugins\/[^']*)'/g)) expect(['../src/plugins/logic', '../src/plugins/cli'], `${f} imports ${m[1]}`).toContain(m[1]);
    }
  });

  it('has no string that is a plugin id or a command, view or tool name of one', () => {
    const cat = catalog();
    const names = new Set<string>(); // plugin ids and command namespaces
    const whole = new Set<string>(); // full command, view and tool names
    for (const p of cat.plugins()) {
      if (p.id === 'core') continue;
      names.add(p.id);
      for (const n of [...p.commands, ...p.views]) {
        names.add(n.split('.')[0]);
        whole.add(n);
      }
      for (const n of p.commands) if (cat.spec(n)?.tool) names.add(cat.spec(n)!.tool!.split('_')[0]);
    }
    names.delete('canvas'); // the generic tools' own prefix
    expect([...names]).toEqual(expect.arrayContaining(['board', 'chess', 'diagram']));
    for (const f of files) {
      for (const m of code(f).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
        const s = m[1] ?? m[2] ?? m[3];
        expect(whole.has(s), `${f}: "${s}" is a plugin command`).toBe(false);
        for (const n of names) expect(s === n || s.startsWith(`${n}_`), `${f}: "${s}" names the ${n} plugin`).toBe(false);
      }
    }
  });

  it('views.ts and chess.ts have moved into the plugin', () => {
    for (const f of ['views.ts', 'chess.ts', 'chatText.ts', 'query.ts', 'backlog.ts']) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(existsSync(join(dir, '../src/plugins/chess/text.ts'))).toBe(true);
  });
});
