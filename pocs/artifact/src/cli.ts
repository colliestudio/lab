// recap CLI: tiny subcommand dispatcher. Run with `pnpm recap <cmd>` or `bin/recap.js <cmd>`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkBundle } from "./check.ts";
import { collect, EMPTY_BASE } from "./collect.ts";
import { renderMarkdown } from "./md.ts";
import { loadBundle, openFiles, packFiles, zipFiles } from "./parse/index.ts";

type Cmd = (args: string[]) => Promise<number>;

const USAGE = `recap <command>

  model <bundle>                         print the parsed JSON model
  check <bundle>                         lint (exit 1 on errors)
  collect (--base <ref> | --root) [--head <ref>] [--repo <dir>] -o <bundle> [--force]
                                         write changes.patch + a doc.md scaffold
                                         (--root = against the empty tree: the whole repo at head)
  pack <dir> [-o <zip>]                  dir bundle → zip (in place unless -o)
  unpack <zip> [-o <dir>]                zip bundle → dir (in place unless -o)
  comments <bundle> [--open]             print comments.json
  md <bundle> [--link <url>]             GitHub comment fallback (markdown + Mermaid map)
  serve | build | server | publish       viewer / hosting (src/server)
`;

const commands: Record<string, Cmd> = {
  async model(args) {
    const { pos } = parseArgs(args);
    const b = await loadBundle(need(pos[0], "bundle"));
    process.stdout.write(JSON.stringify(b.doc, null, 2) + "\n");
    return 0;
  },

  async check(args) {
    const { pos } = parseArgs(args);
    const b = await loadBundle(need(pos[0], "bundle"));
    const r = checkBundle(b);
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const e of r.errors) console.log(`error: ${e}`);
    console.log(`${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
    return r.errors.length ? 1 : 0;
  },

  async collect(args) {
    const { flags } = parseArgs(args);
    const r = collect({
      base: flags.root === "true" ? EMPTY_BASE : need(flags.base, "--base (or --root)"),
      head: flags.head,
      repo: flags.repo,
      out: need(flags.o ?? flags.out, "-o"),
      force: flags.force === "true",
    });
    console.log(`wrote ${r.patchPath} (${r.files} files)`);
    if (r.docKept) console.log("kept existing doc.md (--force to overwrite)");
    else console.log(`wrote ${r.docPath}; rewrite it, then \`recap check\``);
    return 0;
  },

  async pack(args) {
    const { pos, flags } = parseArgs(args);
    const src = resolve(need(pos[0], "dir"));
    if (!statSync(src).isDirectory()) throw new Error(`${pos[0]} is not a directory`);
    const zip = packFiles(openFiles(src));
    zipFiles(zip); // sanity: readable
    if (flags.o) {
      writeFileSync(resolve(flags.o), zip);
      console.log(`wrote ${flags.o}`);
    } else {
      const tmp = src + ".packing";
      writeFileSync(tmp, zip);
      rmSync(src, { recursive: true });
      renameSync(tmp, src);
      console.log(`packed ${pos[0]} (now a zip file)`);
    }
    return 0;
  },

  async unpack(args) {
    const { pos, flags } = parseArgs(args);
    const src = resolve(need(pos[0], "zip"));
    if (statSync(src).isDirectory()) throw new Error(`${pos[0]} is already a directory`);
    const files = zipFiles(readFileSync(src));
    const write = (dir: string) => {
      for (const p of files.list()) {
        const f = join(dir, p);
        if (!f.startsWith(dir + "/")) continue;
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, files.read(p)!);
      }
    };
    if (flags.o) {
      write(resolve(flags.o));
      console.log(`wrote ${flags.o}/`);
    } else {
      const tmp = src + ".unpacking";
      rmSync(tmp, { recursive: true, force: true });
      write(tmp);
      rmSync(src);
      renameSync(tmp, src);
      console.log(`unpacked ${pos[0]} (now a directory)`);
    }
    return 0;
  },

  async comments(args) {
    const { pos, flags } = parseArgs(args);
    const b = await loadBundle(need(pos[0], "bundle"), { linkPlan: false });
    const raw = b.files.read("comments.json");
    let list: { resolved?: boolean }[] = raw ? JSON.parse(new TextDecoder().decode(raw)) : [];
    if (flags.open === "true") list = list.filter((c) => !c.resolved);
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return 0;
  },

  async md(args) {
    const { pos, flags } = parseArgs(args);
    const b = await loadBundle(need(pos[0], "bundle"));
    process.stdout.write(renderMarkdown(b.doc, { link: flags.link }));
    return 0;
  },

  // ---- STUBS: implemented by the serve/build/server dev in src/server/index.ts ----
  // Contract: `export async function run(cmd: string, args: string[]): Promise<number>`
  serve: (args) => server("serve", args),
  build: (args) => server("build", args),
  server: (args) => server("server", args),
  publish: (args) => server("publish", args),
};

async function server(cmd: string, args: string[]): Promise<number> {
  const spec = "./server/index.ts"; // via a variable so tsc doesn't require the module to exist
  let mod: { run?: (cmd: string, args: string[]) => Promise<number> };
  try {
    mod = await import(spec);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if ((err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") && String(err.message).includes("server/index")) {
      console.error(`recap ${cmd}: not implemented yet`);
      return 2;
    }
    throw e;
  }
  if (typeof mod.run !== "function") {
    console.error(`recap ${cmd}: not implemented yet (src/server/index.ts has no run export)`);
    return 2;
  }
  return mod.run(cmd, args);
}

/** `-o x --base main pos1 --flag` → {pos, flags}; a flag followed by another flag (or nothing) is "true". */
export function parseArgs(args: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") && a.length > 1) {
      const [k, v] = a.replace(/^--?/, "").split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = v;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) flags[k] = args[++i];
      else flags[k] = "true";
    } else pos.push(a);
  }
  return { pos, flags };
}

function need(v: string | undefined, what: string): string {
  if (!v || v === "true") throw new UsageError(`missing ${what}`);
  return v;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { process.stdout.write(USAGE); return 0; }
  const fn = commands[cmd];
  if (!fn) { process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`); return 2; }
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`recap ${cmd}: ${e.message}\n\n${USAGE}`); return 2; }
    process.stderr.write(`recap ${cmd}: ${(e as Error).message}\n`);
    if (process.env.RECAP_DEBUG) console.error(e);
    return 1;
  }
}

if (existsSync(process.argv[1] ?? "") && resolve(process.argv[1]).endsWith("src/cli.ts")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
