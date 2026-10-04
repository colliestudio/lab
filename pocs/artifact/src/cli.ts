// recap CLI: tiny subcommand dispatcher. Run with `pnpm recap <cmd>` or `bin/recap.js <cmd>`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkBundle } from "./check.ts";
import { collect, EMPTY_BASE } from "./collect.ts";
import { renderMarkdown } from "./md.ts";
import { loadBundle, openFiles, packFiles, zipFiles } from "./parse/index.ts";
import { parseArgs } from "./args.ts";
import { commentsFile, readComments } from "./server/bundle.ts";
import { run as runServer } from "./server/index.ts";

type Cmd = (args: string[]) => Promise<number>;

const USAGE = `recap <command>

  model <bundle>                         print the parsed JSON model
  check <bundle>                         lint (exit 1 on errors)
  collect (--base <ref> | --root) [--head <ref>] [--repo <dir>] -o <bundle> [--force]
                                         write changes.patch + a doc.md scaffold
                                         (--root = against the empty tree: the whole repo at head)
  pack <dir> [-o <zip>]                  dir bundle → zip (in place unless -o)
  unpack <zip> [-o <dir>]                zip bundle → dir (in place unless -o)
  comments <bundle> [--open]             print comments (dir: comments.json; zip: <bundle>.comments.json)
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
    let list = readComments(commentsFile(b.path), b.files);
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

  serve: (args) => runServer("serve", args),
  build: (args) => runServer("build", args),
  server: (args) => runServer("server", args),
  publish: (args) => runServer("publish", args),
};

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
