import { catalog } from './catalog';
import { client } from './client';
import { cliArgs, parseArgv } from './flags';
import { buildForms, findForm, formUsage, type Form } from './forms';
import { chatText } from '../src/core/chat';
import { apiBase, followChat } from './follow';
import { PLUGIN_CLI } from '../src/plugins/cli';

// canvas: edit a live canvas from the shell (agents, scripts, people). Talks to the bridge.
//   pnpm canvas <command> [args] [--as NAME] [--bridge URL]
// Nodes are named by id or by title (unique prefix/substring is enough). Besides the built-ins below,
// the verbs come from what plugins describe (their `cli` forms) and add (src/plugins/cli.ts).

const cat = catalog();

const forms = buildForms(cat);

function help() {
  const lines = forms.map((f) => {
    const spec = f.kind === 'command' ? cat.spec(f.name)! : cat.viewSpec(f.name)!;
    return `  ${formUsage(cat, f)}\n      ${spec.description.split(/(?<=\.)\s/)[0]}`;
  });
  return `canvas: read and edit a live canvas through the bridge

  status                                  file, counts, who is seated
  list [--type T] [--column C] [--json]   nodes, one per line
  query [--type T] [--text S] [--column C] [--ext x-NS]   JSON
  show                                    the .canvas file text
  undo | redo                             your own last step (per --as)
  log [-n 20]
  help [PLUGIN [COMMAND]]                 what plugins can do: guide, commands, views
  run NAME [JSON]                         any command, args checked (canvas help lists them)
  view NAME [JSON]                        read a plugin view
  wait NAME [JSON] [--timeout S]          block until a view is ready (≤290 s)
  cmd NAME [JSON]                         raw command, unchecked
  chat say TEXT [--node N]                say something in the table chat (@Name mentions; --node = about a node)
  chat read [-n 20] [--new] [--json]      last messages, or only what's new since you last looked
  chat wait [--timeout S]                 block until someone else says something (≤290 s), print it
  chat wait --follow                      keep printing what others say, one batch per message (for a Monitor); ends if the service is gone

From the plugins (arguments marked ... take the remaining words; V = a value; none clears where an argument can be cleared):
${lines.join('\n')}
${PLUGIN_CLI.map((x) => `  ${x.usage}`).join('\n')}

  --as NAME     who you are on the board (default $CANVAS_AS or "Claude")
  --bridge URL  default $CANVAS_BRIDGE or http://localhost:5222
  --board NAME  a board of canvas serve instead of the bridge: URL is --bridge, else $CANVAS_SERVE, else http://localhost:5231
  --json        print JSON instead of text`;
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0); // `canvas list | head`
  throw e;
});
const argv = process.argv.slice(2);
const { pos, flags, rest } = parseArgv(argv);
const [command, ...params] = pos;
const extra = PLUGIN_CLI.find((x) => x.verb.split(' ').every((w, i) => pos[i] === w));
const c = client({ url: apiBase({ bridge: flags.bridge, board: flags.board }), as: flags.as ?? extra?.as, kind: extra?.kind === 'tool' ? 'tool' : 'agent' });
const num = (k: string) => (flags[k] !== undefined ? Number(flags[k]) : undefined);
const say = (line: string) => console.log(line);
const parseJson = (s: string | undefined) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    throw new Error(`not JSON: ${s}`);
  }
};

async function main() {
  switch (command) {
    case undefined:
    case '--help':
      return console.log(help());
    case 'help':
      return console.log(params.length ? cat.helpText(params[0], params[1]) : help());
    case 'status':
      return console.log(JSON.stringify(await c.status(), null, 2));
    case 'show':
      return process.stdout.write(JSON.stringify(await c.doc(), null, '\t') + '\n');
    case 'list': {
      const ns = await c.query({ type: flags.type, column: flags.column, text: flags.text });
      if (flags.json) return console.log(JSON.stringify(ns, null, 2));
      for (const n of ns) {
        const t = (n.text ?? '').split('\n')[0];
        const links = n.links?.map((l) => `→${l.to}${l.label ? `(${l.label})` : ''}`).join(' ') ?? '';
        console.log(`${n.id.padEnd(18)} ${n.type.padEnd(6)} ${String(Math.round(n.x)).padStart(6)},${String(Math.round(n.y)).padEnd(6)} ${n.column ? `[${n.column}] ` : ''}${t}${links ? '  ' + links : ''}`);
      }
      return;
    }
    case 'query':
      return console.log(JSON.stringify(await c.query({ type: flags.type, text: flags.text, column: flags.column, ext: flags.ext }), null, 2));
    case 'undo':
    case 'redo': {
      const r = await c.undo(command === 'redo');
      if (!r.ok) throw new Error(r.error);
      return console.log(`${command} done`);
    }
    case 'log':
      for (const e of await c.log(num('n') ?? 20)) console.log(`${e.time.slice(11, 19)}  ${e.actor ?? '—'} ${e.text}`);
      return;
    case 'cmd':
      return console.log(JSON.stringify(await c.cmd(params[0], parseJson(params[1])), null, 2));
    case 'run':
      if (!params[0]) throw new Error('run NAME [JSON]  (canvas help lists the commands)');
      return report(await c.run(params[0], parseJson(params[1])));
    case 'view':
      if (!params[0]) throw new Error('view NAME [JSON]');
      return showView(params[0], await c.view(params[0], parseJson(params[1])));
    case 'wait': {
      if (!params[0]) throw new Error('wait NAME [JSON] [--timeout S]');
      const v = await c.waitLong(params[0], parseJson(params[1]), num('timeout') ?? 290);
      if (v === undefined) throw new Error(`timed out: ${cat.viewSpec(params[0])?.waiting ?? 'still not ready'}`);
      return showView(params[0], v);
    }
    case 'chat':
      return chat(params[0], params.slice(1));
  }
  if (extra) return extra.run(c, { pos: pos.slice(extra.verb.split(' ').length), flags, rest, say });
  const f = findForm(forms, pos);
  if (f) return runForm(f, pos.slice(f.words.length));
  throw new Error(`unknown command: ${command}\n\n${help()}`);
}

function report(r: { result: unknown; text?: string; changed?: number; undescribed?: boolean }) {
  if (flags.json) return console.log(JSON.stringify(r.result, null, 2));
  if (r.changed === 0) console.log('(no change)');
  const id = (r.result as { id?: unknown } | null)?.id;
  // a result that is only the change count has nothing more to show
  const only = r.result && typeof r.result === 'object' && Object.keys(r.result).every((k) => k === 'changed');
  if (r.text !== undefined || typeof id === 'string' || !only) console.log(r.text ?? (typeof id === 'string' ? id : JSON.stringify(r.result, null, 2)));
}

function showView(name: string, v: unknown) {
  const text = cat.viewSpec(name)?.text;
  console.log(flags.json || !text ? JSON.stringify(v, null, 2) : text(v));
}

async function runForm(f: Form, words: string[]) {
  const spec = f.kind === 'command' ? cat.spec(f.name)! : cat.viewSpec(f.name)!;
  const args = cliArgs(cat.jsonSchema(spec.args), f.form, words, flags);
  if (f.kind === 'command') return report(await c.run(f.name, args));
  const vs = cat.viewSpec(f.name)!;
  if (!vs.wait) return showView(f.name, await c.view(f.name, args));
  const v = await c.waitLong(f.name, args, num('timeout') ?? 290);
  if (v === undefined) throw new Error(`timed out: ${vs.waiting ?? 'still not ready'}`);
  showView(f.name, v);
}

async function chat(sub: string | undefined, args: string[]) {
  const show = async (msgs: Awaited<ReturnType<typeof c.chatRead>>) => (flags.json ? console.log(JSON.stringify(msgs, null, 2)) : msgs.length && console.log(chatText(msgs, await c.doc())));
  switch (sub) {
    case 'say': {
      if (!args.length) throw new Error('chat say TEXT [--node N]');
      const m = await c.say(args.join(' '), flags.node);
      return console.log(`sent (${m.id})`);
    }
    case undefined:
    case 'read': {
      const msgs = await c.chatRead({ limit: num('n'), onlyNew: !!flags.new });
      if (!msgs.length && !flags.json) return console.log(flags.new ? '(nothing new)' : '(no messages)');
      return show(msgs);
    }
    case 'wait': {
      if (flags.follow) return followChat(c, (t) => console.log(t), { warn: (m) => console.error(`canvas: ${m}`) });
      const msgs = await c.chatWait(num('timeout') ?? 290);
      if (!msgs.length) throw new Error('timed out: nothing new');
      return show(msgs);
    }
    default:
      throw new Error(`unknown chat command: ${sub} (say | read | wait)`);
  }
}

main().catch((e) => {
  console.error(`canvas: ${(e as Error).message}`);
  process.exit(1);
});
