import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SOURCE_NAME } from '../commands';
import { BacklogMdSource, type BacklogMdOptions } from './backlogMd';

// Which Backlog.md folders a serve offers, by name. The operator names them when starting the serve
// (--kanban name=path, repeatable, or $CANVAS_KANBAN="a=path,b=path"); a kanban node on a board stores
// only the name. No path is ever taken from a board, a client or an agent.

export interface KanbanConfig {
  name: string;
  path: string;
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p);

/** `name=path` entries from the flag values and the environment; throws an Error that says which entry is wrong. */
export function parseKanbanConfig(flags: string[] = [], env?: string): KanbanConfig[] {
  const entries = [...flags.map((v) => ({ v, from: '--kanban' })), ...(env ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => ({ v, from: '$CANVAS_KANBAN' }))];
  const out: KanbanConfig[] = [];
  for (const { v, from } of entries) {
    const eq = v.indexOf('=');
    if (eq < 0) throw new Error(`${from} "${v}": expected name=path`);
    const name = v.slice(0, eq).trim();
    const path = v.slice(eq + 1).trim();
    if (!SOURCE_NAME.test(name)) throw new Error(`${from} "${name}": a name is lowercase letters, digits and dashes (at most 32), starting with a letter or digit`);
    if (!path) throw new Error(`${from} ${name}: the path is empty`);
    const prior = out.find((c) => c.name === name);
    if (prior) {
      if (resolve(expand(prior.path)) === resolve(expand(path))) continue; // the same folder given twice (flag and environment)
      throw new Error(`${from} ${name}: the name is used twice for different folders`);
    }
    out.push({ name, path: resolve(expand(path)) });
  }
  return out;
}

/** One adapter per name, shared by every board and node that shows it (one write queue per folder). */
export class SourceRegistry {
  private sources = new Map<string, BacklogMdSource>();

  constructor(configs: KanbanConfig[], opts: BacklogMdOptions = {}) {
    for (const c of configs) {
      try {
        this.sources.set(c.name, new BacklogMdSource(c.path, opts));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        throw new Error(`kanban ${c.name}: ${code === 'ENOENT' ? `${c.path} is not a Backlog.md folder (no backlog.config.yml or config.yml found)` : (e as Error).message}`);
      }
    }
  }

  names(): string[] {
    return [...this.sources.keys()];
  }

  get(name: string): BacklogMdSource | undefined {
    return this.sources.get(name);
  }
}
