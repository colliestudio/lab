#!/usr/bin/env node
// Runs the TS CLI through tsx (lab: no build step for the CLI).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "src/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
