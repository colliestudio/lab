import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    // Alex opens the dev server through a proxy at http://mini.internal:5190.
    allowedHosts: ['.internal'],
  },
  test: {
    environment: 'node',
  },
});
