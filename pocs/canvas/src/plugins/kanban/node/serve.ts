import type { ServeExtra } from '../../../core/serveExtra';
import { attachKanban } from './attach';
import { parseKanbanConfig, SourceRegistry } from './registry';

/** What the kanban plugin adds to `canvas serve`: the folders it may show, a say in /api/info, and a sync per kanban node. */
export const kanbanServe: ServeExtra = {
  id: 'kanban',
  flags: [{ name: 'kanban', help: 'name=path: a Backlog.md project (or its backlog folder) that kanban nodes can show; repeatable, or $CANVAS_KANBAN="a=path,b=path"' }],
  start({ flags, env }) {
    const configs = parseKanbanConfig(flags.kanban, env.CANVAS_KANBAN);
    const registry = new SourceRegistry(configs);
    return {
      // names only: a browser learns which folders it can pick, never where they are
      info: () => ({ kanban: registry.names() }),
      attach: (b) => attachKanban(b, registry),
      describe: () => (configs.length ? `kanban folders: ${configs.map((c) => `${c.name} (${c.path})`).join(', ')}` : undefined),
    };
  },
};
