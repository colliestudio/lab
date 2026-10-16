import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';

// The bridge names no plugin: what plugins can do arrives through their descriptions (the catalog).
// A plugin's name or command in bridge code means a plugin got special treatment the others can't have.

const dir = __dirname;
const root = join(dir, '..');
// the bridge and the server it runs on (server/ has the host, the catalog, the API)
function sourcesIn(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesIn(join(d, e.name)) : e.name.endsWith('.ts') && !/\.test(-util)?\.ts$/.test(e.name) ? [join(d, e.name)] : []));
}
const files = [...sourcesIn(dir), ...sourcesIn(join(root, 'server'))].map((f) => f.slice(root.length + 1));
// comments are not code: strip them before looking for names
const code = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function pluginSources(dirPath = join(dir, '../src/plugins')): string[] {
  return readdirSync(dirPath, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pluginSources(join(dirPath, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dirPath, e.name)] : []));
}

describe('bridge/ and server/ stay generic', () => {
  it('imports no plugin but the list and the CLI extras', () => {
    const allowed = [join(root, 'src/plugins/logic'), join(root, 'src/plugins/cli')];
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+'([^']*src\/plugins\/[^']*)'/g)) expect(allowed, `${f} imports ${m[1]}`).toContain(resolve(root, f, '..', m[1]));
    }
  });

  it('server/core is portable: no node:, fs, path, http or ws imports', () => {
    const core = files.filter((f) => f.startsWith('server/core/'));
    expect(core.length).toBeGreaterThan(2);
    for (const f of core) {
      for (const m of code(f).matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        expect(/^(node:|(fs|path|http|https|net|os|child_process|crypto|stream|url|util|events|buffer|ws)(\/|$))/.test(m[1]), `${f} imports ${m[1]}`).toBe(false);
      }
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
        for (const x of xfields) expect(new RegExp(`(^|[^A-Za-z0-9-])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`).test(s), `${f}: "${s}" names the plugin field ${x}`).toBe(false);
      }
    }
  });

  it('views.ts and chess.ts have moved into the plugin', () => {
    for (const f of ['views.ts', 'chess.ts', 'chatText.ts', 'query.ts', 'backlog.ts']) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(existsSync(join(dir, '../src/plugins/chess/text.ts'))).toBe(true);
  });
});
