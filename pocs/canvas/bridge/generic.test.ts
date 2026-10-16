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

function pluginSources(dirPath = join(dir, '../src/plugins')): string[] {
  return readdirSync(dirPath, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pluginSources(join(dirPath, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dirPath, e.name)] : []));
}

describe('bridge/ stays generic', () => {
  it('imports no plugin but the list and the CLI extras', () => {
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+'([^']*src\/plugins\/[^']*)'/g)) expect(['../src/plugins/logic', '../src/plugins/cli'], `${f} imports ${m[1]}`).toContain(m[1]);
    }
  });

  it('has no string that names a plugin, its commands, tools or storage fields', () => {
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
    // the x- fields plugins write on nodes (x-shape, x-chess…), read off their sources
    const xfields = new Set<string>();
    for (const f of pluginSources()) for (const m of readFileSync(f, 'utf8').matchAll(/['"`](x-[a-z][a-z-]*)/g)) xfields.add(m[1]);
    expect([...xfields]).toEqual(expect.arrayContaining(['x-shape', 'x-chess']));
    for (const f of files) {
      for (const m of code(f).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
        const s = m[1] ?? m[2] ?? m[3];
        for (const w of whole) expect(new RegExp(`(^|[^A-Za-z0-9.])${w.replace('.', '\\.')}($|[^A-Za-z0-9])`).test(s), `${f}: "${s}" mentions the command ${w}`).toBe(false);
        for (const n of names) expect(new RegExp(`(^|[^A-Za-z0-9-])${n}_`).test(s) || s === n || (s !== 'board.canvas' && new RegExp(`(^|[^A-Za-z0-9.-])${n}\\.([a-z]|$)`).test(s)), `${f}: "${s}" names the ${n} plugin`).toBe(false);
        for (const x of xfields) expect(s.includes(x), `${f}: "${s}" names the plugin field ${x}`).toBe(false);
      }
    }
  });

  it('views.ts and chess.ts have moved into the plugin', () => {
    for (const f of ['views.ts', 'chess.ts', 'chatText.ts', 'query.ts', 'backlog.ts']) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(existsSync(join(dir, '../src/plugins/chess/text.ts'))).toBe(true);
  });
});
