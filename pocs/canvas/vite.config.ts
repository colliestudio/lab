import { defineConfig } from 'vitest/config';
import { kanbanDevFolder } from './vite-kanban';

export default defineConfig({
  plugins: [kanbanDevFolder()],
  server: {
    // Alex opens the dev server through a proxy at http://mini.internal:5190.
    allowedHosts: ['.internal'],
    proxy: {
      // kanban "service" source: a running Backlog.md server (`backlog browser`). It sends no CORS
      // headers, so the page reaches it same-origin. BACKLOG_URL picks the instance (default: 6421).
      '/backlog-api': {
        target: process.env.BACKLOG_URL ?? 'http://127.0.0.1:6421',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/backlog-api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
  },
});
