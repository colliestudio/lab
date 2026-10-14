// Entry for `recap serve | build | server | publish` (src/cli.ts calls run).
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildHtml, fmtBytes, sizeReport } from "./build.ts";
import { CODE_LEVEL_LABEL, parseCodeLevel } from "../code-level.ts";
import { startHosted } from "./hosted.ts";
import { parseArgs } from "../args.ts";
import { publish, savedSecret, saveRecord } from "./publish.ts";
import { startServe, type Running } from "./serve.ts";

export { buildHtml, startHosted, publish, startServe };

const USAGE = `usage:
  recap serve <bundle> [--port N] [--open]
  recap build <bundle> -o out.html [--code none|key|full] [--force]
    --code: key (default) = only the hunks diff/code blocks show; full = all of changes.patch; none = no code
    warns over 5 MB, refuses over 25 MB unless --force
  recap server --data <dir> [--port N] [--host H] [--token T]
  recap publish <bundle> --to <url> [--token T] [--id <id> [--secret S]]
    first publish saves the doc's edit secret to .recap-publish.json next to the bundle;
    re-publish with --id uses it (or --secret / RECAP_EDIT_SECRET, or the server token)`;

function parse(args: string[]) {
  const { pos, flags } = parseArgs(args);
  const str = (k: string) => (flags[k] && flags[k] !== "true" ? flags[k] : undefined);
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
    const { pos, flags, str, port } = parse(args);
    switch (cmd) {
      case "serve": {
        if (!pos[0]) break;
        const r = await startServe(pos[0], { port });
        console.log(`serving ${pos[0]} at ${r.url}  (Ctrl-C to stop)`);
        if (flags.open === "true") spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [r.url], { stdio: "ignore", detached: true }).unref();
        return untilSignal(r);
      }
      case "build": {
        const out = str("o") ?? str("out");
        if (!pos[0] || !out) break;
        const { html, files, parts, code, stripped } = await buildHtml(pos[0], { code: parseCodeLevel(str("code")) });
        const total = Buffer.byteLength(html);
        const r = sizeReport(total, parts, code);
        if (r.level === "refuse" && flags.force !== "true") {
          console.error(r.lines.join("\n"));
          return 1;
        }
        writeFileSync(out, html);
        console.log(`wrote ${out} (${fmtBytes(total)}; code: ${stripped || code === "full" ? CODE_LEVEL_LABEL[code] : "nothing to strip"}; ${files.length} file${files.length === 1 ? "" : "s"} inlined)`);
        console.log(r.lines.join("\n"));
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
        const id = str("id");
        const secret = id ? str("secret") ?? process.env.RECAP_EDIT_SECRET ?? savedSecret(pos[0], to, id) : undefined;
        const r = await publish(pos[0], { to, token: str("token") ?? process.env.RECAP_TOKEN, id, secret });
        console.log(r.url);
        if (r.secret) {
          const file = saveRecord(pos[0], to, r);
          console.error(`id ${r.id}; edit secret saved to ${file} (keep it out of git). Re-publish: recap publish ${pos[0]} --to ${to} --id ${r.id}`);
        }
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
