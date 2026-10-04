// Dev harness for the demo block only (not the viewer build): pnpm exec vite --config viewer/harness/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../test/fixtures/sample.review", import.meta.url)),
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
