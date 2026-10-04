// Entry for `recap serve | build | server | publish` (src/cli.ts dynamic-imports this and calls run).
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildHtml } from "./build.ts";
import { startHosted } from "./hosted.ts";
import { publish } from "./publish.ts";
import { startServe, type Running } from "./serve.ts";

export { buildHtml, startHosted, publish, startServe };

const USAGE = `usage:
  recap serve <bundle> [--port N] [--open]
  recap build <bundle> -o out.html
  recap server --data <dir> [--port N] [--host H] [--token T]
  recap publish <bundle> --to <url> [--token T] [--id <id>]`;

function parseArgs(args: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) { pos.push(a); continue; }
    if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (m[1] === "open") flags.open = true;
    else if (i + 1 < args.length) flags[m[1]] = args[++i];
    else flags[m[1]] = true;
  }
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const port = str("port") ? Number(str("port")) : undefined;
  if (port !== undefined && !Number.isInteger(port)) throw new Error("--port must be a number");
  return { pos, flags, str, port };
}

/** Resolves on SIGINT/SIGTERM after closing the server. */
function untilSignal(r: Running): Promise<number> {
  return new Promise((ok) => {
    const stop = () => { r.close().then(() => ok(0)); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function run(cmd: string, args: string[]): Promise<number> {
  try {
    const { pos, flags, str, port } = parseArgs(args);
    switch (cmd) {
      case "serve": {
        if (!pos[0]) break;
        const r = await startServe(pos[0], { port });
        console.log(`serving ${pos[0]} at ${r.url}  (Ctrl-C to stop)`);
        if (flags.open) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [r.url], { stdio: "ignore", detached: true }).unref();
        return untilSignal(r);
      }
      case "build": {
        const out = str("o") ?? str("out");
        if (!pos[0] || !out) break;
        const { html, files } = await buildHtml(pos[0]);
        writeFileSync(out, html);
        console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${files.length} file${files.length === 1 ? "" : "s"} inlined)`);
        return 0;
      }
      case "server": {
        const data = str("data");
        if (!data) break;
        const r = await startHosted({ data, port, host: str("host"), token: str("token") ?? process.env.RECAP_TOKEN });
        console.log(`recap server on ${r.url}  data=${data}${str("token") || process.env.RECAP_TOKEN ? "  (token required to publish)" : ""}`);
        return untilSignal(r);
      }
      case "publish": {
        const to = str("to");
        if (!pos[0] || !to) break;
        const r = await publish(pos[0], { to, token: str("token") ?? process.env.RECAP_TOKEN, id: str("id") });
        console.log(r.url);
        return 0;
      }
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(`recap ${cmd}: ${(e as Error).message}`);
    return 1;
  }
}
