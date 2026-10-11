import { defineConfig } from 'vitest/config';
import { kanbanDevFolder } from './vite-kanban';

export default defineConfig({
  plugins: [kanbanDevFolder()],
  server: {
    // Alex opens the dev server through a proxy at http://mini.internal:5190.
    allowedHosts: ['.internal'],
    // kanban "service" source: a running Backlog.md server (`backlog browser`). It sends no CORS
    // headers, so the page reaches it same-origin. Only when BACKLOG_URL names the instance: no default,
    // so the dev server never fronts a board nobody chose (vite-kanban.ts limits who can reach it).
    proxy: process.env.BACKLOG_URL
      ? {
          '/backlog-api': {
            target: process.env.BACKLOG_URL,
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/backlog-api/, ''),
          },
        }
      : undefined,
  },
  test: {
    environment: 'node',
  },
});
