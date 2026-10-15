import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { client } from './client';
import { parseBacklog } from './backlog';
import { COLORS, gameText, playMove, runBot, waitForTurn } from './chess';
import { chatText } from './chatText';
import type { GameView } from '../src/plugins/chess/game';

// canvas: edit a live canvas from the shell (agents, scripts, people). Talks to the bridge.
//   pnpm canvas <command> [args] [--as NAME] [--bridge URL]
// Nodes are named by id or by title (unique prefix/substring is enough).

const HELP = `canvas: read and edit a live canvas through the bridge

  status                                  file, counts, who is seated
  list [--type T] [--column C] [--json]   nodes, one per line
  query [--type T] [--text S] [--column C] [--ext x-NS]   JSON
  show                                    the .canvas file text
  add-node TEXT [--column C] [--near N] [--x X --y Y] [--color 1-6|#hex] [--url U]
  add-column LABEL [--x X --y Y]
  update N [--text T] [--label L] [--color C|none]
  move N (--x X --y Y | --dx DX --dy DY | --column C)
  connect FROM TO [--label L]            plain link (board)
  disconnect FROM TO
  shape KIND [TEXT] [--x X --y Y | --near N --side top|right|bottom|left] [--from N]
        [--width W --height H] [--stroke C] [--fill C|none] [--dashed] [--size PX]
                                          diagram shape: rect|ellipse|diamond|text|sticky; --from N = new shape with an arrow from N
  style N [--text T] [--kind K] [--stroke C|none] [--fill C|none] [--dashed true|false] [--size PX]
        [--x X --y Y | --dx DX --dy DY] [--width W --height H]
  arrow FROM TO [--label L] [--from-side S] [--to-side S] [--start arrow|none] [--end arrow|none]
        [--dashed] [--curve] [--color 1-6|#hex]   diagram arrow; prints its id
  arrow-edit ID [--label L|none] [--from-side S] [--to-side S] [--start E] [--end E] [--dashed true|false] [--curve true|false] [--color C|none]
  arrow-rm ID [ID…]
  rm N [N…]
  undo | redo                             your own last step (per --as)
  log [-n 20]
  cmd NAME [JSON]                         any registered command (board.*, core.*)
  sync-backlog [--dir PATH] [-- backlog filters…]   Backlog.md tasks → columns (re-runnable)

  chess state [--json]                    the game: board, turn, seats, legal moves, FEN
  chess new [--x X --y Y]                 new game on the board (or a new set with rules on)
  chess sit white|black [--leave]         take (or leave) a seat: only you move that color
  chess move MOVE                         e2e4, e7e8q, Nf3, O-O … (fails with the legal list)
  chess wait [--timeout S]                block until it's your move (or the game ended)
  chess takeback                          undo your last move and the reply (plain undo is off in a rules game)
  chess resign
  bot chess [--color black] [--depth 2] [--delay 600] [--keep]
                                          built-in opponent: sits, waits, moves (as --as, default "Bot")
  chess commands take --board ID when there is more than one board

  chat say TEXT [--node N]                say something in the table chat (@Name mentions; --node = about a node)
  chat read [-n 20] [--new] [--json]      last messages, or only what's new since you last looked
  chat wait [--timeout S]                 block until someone else says something (≤290 s), print it

  --as NAME     who you are on the board (default $CANVAS_AS or "Claude")
  --bridge URL  default $CANVAS_BRIDGE or http://localhost:5222`;

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0); // `canvas list | head`
  throw e;
});
const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const pos: string[] = [];
let rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    rest = argv.slice(i + 1);
    break;
  }
  if (a.startsWith('--')) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = 'true';
    else flags[a.slice(2)] = argv[++i];
  } else if (a === '-n') flags.n = argv[++i];
  else pos.push(a);
}
const [command, ...params] = pos;
const isTool = command === 'sync-backlog';
const isBot = command === 'bot';
const c = client({ url: flags.bridge, as: flags.as ?? (isTool ? 'Backlog.md' : isBot ? 'Bot' : undefined), kind: isTool ? 'tool' : 'agent' });
const num = (k: string) => (flags[k] !== undefined ? Number(flags[k]) : undefined);

async function run(name: string, args: unknown) {
  const r = await c.cmd(name, args);
  if (!r.ok) throw new Error(r.error ?? 'failed');
  if (!r.changed) console.log('(no change)');
  return r;
}

const bool = (k: string) => (flags[k] !== undefined ? flags[k] !== 'false' : undefined);
const clear = (v: string | undefined) => (v === 'none' ? null : v);
/** The arrow options shared by `arrow` and `arrow-edit` (core.connect / core.edge arguments). */
function arrowFlags() {
  return {
    label: flags.label === 'none' ? null : flags.label,
    fromSide: flags['from-side'],
    toSide: flags['to-side'],
    fromEnd: flags.start,
    toEnd: flags.end,
    dashed: bool('dashed'),
    curve: bool('curve'),
    color: clear(flags.color),
  };
}

/** A spot beside node `near` (default: below it). */
async function nearSpot(near: string, side = 'bottom') {
  const n = (await c.doc()).nodes.find((x) => x.id === near);
  if (!n) throw new Error(`no node ${near}`);
  const gap = 90;
  const w = num('width') ?? 160;
  const h = num('height') ?? 90;
  const pos: Record<string, { x: number; y: number }> = {
    bottom: { x: n.x + n.width / 2 - w / 2, y: n.y + n.height + gap },
    top: { x: n.x + n.width / 2 - w / 2, y: n.y - gap - h },
    right: { x: n.x + n.width + gap, y: n.y + n.height / 2 - h / 2 },
    left: { x: n.x - gap - w, y: n.y + n.height / 2 - h / 2 },
  };
  const p = pos[side];
  if (!p) throw new Error(`bad --side ${side}`);
  return p;
}

async function main() {
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      return console.log(HELP);
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
    case 'add-node': {
      const text = params.join(' ').replace(/\\n/g, '\n');
      const r = await run('board.add', {
        type: flags.url ? 'link' : 'text',
        text,
        url: flags.url,
        color: flags.color,
        x: num('x'),
        y: num('y'),
        near: flags.near && (await c.resolve(flags.near)),
        column: flags.column && (await c.resolve(flags.column)),
      });
      return console.log(r.select?.[0] ?? '');
    }
    case 'add-column': {
      const r = await run('board.add', { type: 'group', label: params.join(' '), x: num('x'), y: num('y') });
      return console.log(r.select?.[0] ?? '');
    }
    case 'update': {
      const id = await c.resolve(params[0]);
      await run('board.update', { id, text: flags.text?.replace(/\\n/g, '\n'), label: flags.label, color: flags.color === 'none' ? null : flags.color });
      return console.log(id);
    }
    case 'move': {
      const id = await c.resolve(params[0]);
      await run('board.update', { id, x: num('x'), y: num('y'), dx: num('dx'), dy: num('dy'), column: flags.column && (await c.resolve(flags.column)) });
      return console.log(id);
    }
    case 'connect': {
      const [from, to] = await Promise.all([c.resolve(params[0]), c.resolve(params[1])]);
      await run('board.connect', { from, to, label: flags.label });
      return console.log(`${from} → ${to}`);
    }
    case 'shape': {
      const kind = params[0];
      const text = params.slice(1).join(' ').replace(/\\n/g, '\n');
      const style = { stroke: flags.stroke, fill: flags.fill, dashed: flags.dashed ? flags.dashed !== 'false' : undefined, size: num('size'), width: num('width'), height: num('height') };
      if (flags.from) {
        const from = await c.resolve(flags.from);
        const r = await run('diagram.addConnected', { from, kind, text, side: flags.side, at: num('x') !== undefined && num('y') !== undefined ? { x: num('x'), y: num('y') } : undefined, label: flags.label, ...style });
        return console.log(r.select?.[0] ?? '');
      }
      const near = flags.near ? await c.resolve(flags.near) : undefined;
      const r = await run('diagram.add', { kind, text, x: num('x'), y: num('y'), ...(near ? await nearSpot(near, flags.side) : {}), ...style });
      return console.log(r.select?.[0] ?? '');
    }
    case 'style': {
      const id = await c.resolve(params[0]);
      await run('diagram.update', {
        id,
        text: flags.text?.replace(/\\n/g, '\n'),
        kind: flags.kind,
        stroke: clear(flags.stroke),
        fill: flags.fill,
        dashed: flags.dashed ? flags.dashed !== 'false' : undefined,
        size: num('size'),
        x: num('x'),
        y: num('y'),
        dx: num('dx'),
        dy: num('dy'),
        width: num('width'),
        height: num('height'),
      });
      return console.log(id);
    }
    case 'arrow': {
      const [from, to] = await Promise.all([c.resolve(params[0]), c.resolve(params[1])]);
      const r = await run('core.connect', { from, to, ...arrowFlags() });
      return console.log(r.select?.[0] ?? '');
    }
    case 'arrow-edit': {
      await run('core.edge', { id: params[0], ...arrowFlags() });
      return console.log(params[0]);
    }
    case 'arrow-rm':
      return void (await run('core.delete', { ids: params }));
    case 'disconnect': {
      const [from, to] = await Promise.all([c.resolve(params[0]), c.resolve(params[1])]);
      return void (await run('board.disconnect', { from, to }));
    }
    case 'rm': {
      const ids = await Promise.all(params.map((p) => c.resolve(p)));
      return void (await run('board.remove', { ids }));
    }
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
      return console.log(JSON.stringify(await c.cmd(params[0], params[1] ? JSON.parse(params[1]) : {}), null, 2));
    case 'sync-backlog': {
      const dir = (flags.dir ?? `${homedir()}/workspaces/cs`).replace(/^~/, homedir());
      const text = execFileSync('backlog', ['task', 'list', '--plain', ...rest], { cwd: dir, encoding: 'utf8' });
      const input = parseBacklog(text);
      if (!input.items.length) throw new Error(`no tasks parsed from \`backlog task list --plain\` in ${dir}`);
      const at = num('x') !== undefined ? { x: num('x')!, y: num('y') ?? 0 } : undefined;
      const r = await run('board.sync', { ...input, at });
      const log = await c.log(1);
      return console.log(r.changed ? log[0]?.text : `backlog: ${input.items.length} tasks, board already up to date`);
    }
    case 'chat':
      return chat(params[0], params.slice(1));
    case 'chess':
      return chess(params[0], params.slice(1));
    case 'bot': {
      if (params[0] !== 'chess') throw new Error('bot: only `bot chess` so far');
      const color = COLORS[flags.color ?? 'black'];
      if (!color) throw new Error('--color white|black');
      return runBot(c, { color, depth: num('depth') ?? 2, board: flags.board, delayMs: num('delay') ?? 600, keep: !!flags.keep, say: (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`) });
    }
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

async function chat(sub: string | undefined, args: string[]) {
  const show = async (msgs: Awaited<ReturnType<typeof c.chatRead>>) => (flags.json ? console.log(JSON.stringify(msgs, null, 2)) : msgs.length && console.log(await chatText(c, msgs)));
  switch (sub) {
    case 'say': {
      if (!args.length) throw new Error('chat say TEXT [--node N]');
      const m = await c.say(args.join(' '), flags.node && (await c.resolve(flags.node)));
      return console.log(`sent (${m.id})`);
    }
    case undefined:
    case 'read': {
      const msgs = await c.chatRead({ limit: num('n'), onlyNew: !!flags.new });
      if (!msgs.length && !flags.json) return console.log(flags.new ? '(nothing new)' : '(no messages)');
      return show(msgs);
    }
    case 'wait': {
      const msgs = await c.chatWait(num('timeout') ?? 290);
      if (!msgs.length) throw new Error('timed out: nothing new');
      return show(msgs);
    }
    default:
      throw new Error(`unknown chat command: ${sub} (say | read | wait)`);
  }
}

async function chess(sub: string | undefined, args: string[]) {
  const board = flags.board;
  const show = (v: GameView) => console.log(flags.json ? JSON.stringify(v, null, 2) : gameText(v));
  switch (sub) {
    case undefined:
    case 'state':
      return show(await c.view<GameView>('chess.state', { board }));
    case 'new': {
      const existing = board ?? (await c.view<GameView>('chess.state').then((v) => v.board, () => undefined));
      await run('chess.newgame', existing ? { id: existing } : { x: num('x') ?? 0, y: num('y') ?? 0 });
      return show(await c.view<GameView>('chess.state', { board: existing }));
    }
    case 'sit': {
      const color = COLORS[args[0] ?? ''];
      if (!color) throw new Error('chess sit white|black');
      const id = board ?? (await c.view<GameView>('chess.state')).board;
      await run('chess.sit', { id, color, leave: !!flags.leave });
      return show(await c.view<GameView>('chess.state', { board: id }));
    }
    case 'move':
      if (!args[0]) throw new Error('chess move MOVE (e2e4, Nf3, O-O…)');
      return show(await playMove(c, args[0], board));
    case 'wait': {
      const v = await waitForTurn(c, board, num('timeout') ?? 290);
      if (!v) throw new Error('timed out: still not your move');
      return show(v);
    }
    case 'takeback': {
      const id = board ?? (await c.view<GameView>('chess.state')).board;
      await run('chess.takeback', { id });
      return show(await c.view<GameView>('chess.state', { board: id }));
    }
    case 'resign': {
      const id = board ?? (await c.view<GameView>('chess.state')).board;
      await run('chess.resign', { id });
      return show(await c.view<GameView>('chess.state', { board: id }));
    }
    default:
      throw new Error(`unknown chess command: ${sub}`);
  }
}

main().catch((e) => {
  console.error(`canvas: ${(e as Error).message}`);
  process.exit(1);
});

