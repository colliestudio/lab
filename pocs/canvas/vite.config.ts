import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/** Excalidraw's fonts, served from our origin (else it loads them from esm.sh: no offline/desktop). */
const FONTS = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts';
const excalidrawFonts = (): Plugin => ({
  name: 'excalidraw-fonts',
  configureServer(server) {
    server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
      const file = join(FONTS, normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
      if (!existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('content-type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      createReadStream(file).pipe(res);
    });
  },
  writeBundle(opts) {
    cpSync(FONTS, join(opts.dir ?? 'dist', 'excalidraw/fonts'), { recursive: true });
  },
});

export default defineConfig({
  plugins: [excalidrawFonts()],
  // Excalidraw reads this at module load (it also ships a Preact build)
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  server: {
    // Alex opens the dev server through a proxy at http://mini.internal:5190.
    allowedHosts: ['.internal'],
  },
  test: {
    environment: 'node',
  },
});
