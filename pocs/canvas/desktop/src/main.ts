import { app, BrowserWindow, Menu, clipboard, dialog, session, shell, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BoardFile } from '../../bridge/board';
import { BridgeService } from '../../bridge/service';
import { boardId } from '../../bridge/board';
import { ensureLocal } from './icloud';
import { McpEndpoint } from './mcp';
import { APP_NAME, boardsDir, isBoardFile, realPath, userDataDir } from './paths';
import { AgentViews } from './views';

// Collie Canvas desktop. The main process IS the canvas bridge: one BridgeService hosts
// every open .canvas file (live Y.Doc, two-way file sync, autosave), serves the built web app and the
// single MCP endpoint on one random 127.0.0.1 port. Each window = one file, loaded as
// http://127.0.0.1:<port>/?bridge=ws://127.0.0.1:<port>/b/<id> (the web app's bridge mode, unchanged).

const T0 = Date.now();
app.setName(APP_NAME);
app.setPath('userData', resolve(userDataDir()));
const USER = app.getPath('userData');
mkdirSync(join(USER, 'logs'), { recursive: true });
const LOG_FILE = join(USER, 'logs', 'main.log');
const ENDPOINT_FILE = join(USER, 'endpoint.json');
const RECENT_FILE = join(USER, 'recent.json');

function log(...m: unknown[]) {
  const line = `${new Date().toISOString()} ${m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  // a second launch (CLI with a file) hands its files to the running app
  app.quit();
  process.exit(0);
}
app.enableSandbox();

const WEB_DIR = join(__dirname, 'web');
const windows = new Map<string, BrowserWindow>();
let service: BridgeService;
/** Dev: load the web app from the vite dev server (HMR) instead of the built copy. */
const DEV_WEB = process.env.CANVAS_WEB_URL?.replace(/\/+$/, '');
const webOrigin = () => DEV_WEB ?? service.origin;
let views: AgentViews;
let mcp: McpEndpoint;
const pending: string[] = [];
let ready = false;

// ---------------------------------------------------------------- files from the OS / CLI

const canvasArgs = (argv: string[], cwd = process.cwd()) => argv.filter(isBoardFile).map((a) => realPath(resolve(cwd, a)));
pending.push(...canvasArgs(process.argv.slice(1)));
app.on('open-file', (e, path) => {
  // Finder double-click / `open x.canvas` / drop on the Dock icon (may arrive before ready)
  e.preventDefault();
  if (ready) void openBoard(realPath(path));
  else pending.push(realPath(path));
});
app.on('second-instance', (_e, argv, cwd) => {
  for (const f of canvasArgs(argv.slice(1), cwd)) void openBoard(f);
});

// ---------------------------------------------------------------- recent files

function recent(): string[] {
  try {
    return (JSON.parse(readFileSync(RECENT_FILE, 'utf8')) as string[]).filter((f) => existsSync(f));
  } catch {
    return [];
  }
}
function addRecent(file: string) {
  const list = [file, ...recent().filter((f) => f !== file)].slice(0, 12);
  writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2));
  app.addRecentDocument(file);
  buildMenu();
}

// ---------------------------------------------------------------- windows

const CSP = (port: number) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    `connect-src 'self' ws://127.0.0.1:${port}`,
    'frame-src http: https:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

async function openBoard(file: string, opts: { window?: boolean } = {}): Promise<BoardFile> {
  file = resolve(file);
  await ensureLocal(file); // iCloud: fetch an evicted file before the bridge reads it
  const b = service.open(file);
  addRecent(b.file);
  if (opts.window === false) return b;
  const existing = windows.get(b.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return b;
  }
  const t0 = performance.now();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: `${b.name.replace(/\.canvas$/, '')} — ${APP_NAME}`,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:canvas' },
  });
  windows.set(b.id, win);
  win.on('page-title-updated', (e) => e.preventDefault()); // keep our title, not the page's
  win.setRepresentedFilename(b.file);
  win.once('ready-to-show', () => {
    if (process.env.CANVAS_HIDE_WINDOWS !== '1') win.show();
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      // board visible = synced with the bridge and painted
      await win.webContents.executeJavaScript('room.synced.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
      log(`window: ${b.name} visible in ${Math.round(performance.now() - t0)} ms (process start +${Date.now() - T0} ms)`);
      if (process.env.CANVAS_SNAPSHOT_DIR) {
        const img = await win.webContents.capturePage(undefined, { stayHidden: true });
        const out = join(process.env.CANVAS_SNAPSHOT_DIR, `${b.id}.png`);
        writeFileSync(out, img.toPNG());
        log(`window: snapshot ${out}`);
      }
    } catch (e) {
      log(`window: ${b.name} did not sync: ${(e as Error).message}`);
    }
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`renderer ${b.name} ${e.level}: ${e.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, main) => log(`window: ${b.name} load failed ${code} ${desc} ${url} main=${main}`));
  win.on('closed', () => {
    windows.delete(b.id);
    // keep hosting while an agent is seated at it; otherwise close the file
    if (!b.host.seated().length) {
      views.dropBoard(b.id);
      service.close(b.id);
    }
  });
  void win.loadURL(`${webOrigin()}/?bridge=${encodeURIComponent(service.wsUrl(b))}`);
  return b;
}

async function openDialog() {
  const r = await dialog.showOpenDialog({ defaultPath: boardsDir(), properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON Canvas', extensions: ['canvas'] }] });
  for (const f of r.filePaths) void openBoard(f);
}

async function newDialog() {
  const r = await dialog.showSaveDialog({ defaultPath: join(boardsDir(), 'Untitled.canvas'), filters: [{ name: 'JSON Canvas', extensions: ['canvas'] }] });
  if (r.filePath) {
    if (!existsSync(r.filePath)) writeFileSync(r.filePath, '{"nodes":[],"edges":[]}\n');
    void openBoard(r.filePath);
  }
}

// ---------------------------------------------------------------- agents

function shimPath() {
  // inside the packaged app: Contents/Resources/app.asar.unpacked/build/shim.mjs
  return join(__dirname, 'shim.mjs').replace('app.asar', 'app.asar.unpacked');
}

/** The exact commands to register the app's MCP endpoint with Claude Code (shown, never run). */
function connectCommands() {
  const exe = process.execPath;
  const stdio = app.isPackaged
    ? `claude mcp add collie-canvas -s user -e ELECTRON_RUN_AS_NODE=1 -e CANVAS_AS=Claude -- "${exe}" "${shimPath()}"`
    : `claude mcp add collie-canvas -s user -e ELECTRON_RUN_AS_NODE=1 -e CANVAS_AS=Claude -e CANVAS_USER_DATA="${USER}" -- "${exe}" "${shimPath()}"`;
  const http = `claude mcp add --transport http collie-canvas ${service.origin}/mcp`;
  return { stdio, http };
}

async function connectClaude() {
  const c = connectCommands();
  const r = await dialog.showMessageBox({
    type: 'info',
    message: 'Connect Claude Code',
    detail: `Run this once in a terminal (registers the app's single MCP endpoint for all your projects; each Claude session gets its own seat, set CANVAS_AS to name it):\n\n${c.stdio}\n\nThe shim starts the app when it isn't running and finds its port.\n\nDirect HTTP (only valid while this port stays; changes each launch):\n${c.http}`,
    buttons: ['Copy command', 'Copy HTTP command', 'Close'],
    defaultId: 0,
  });
  if (r.response === 0) clipboard.writeText(c.stdio);
  if (r.response === 1) clipboard.writeText(c.http);
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const rec = recent();
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Connect Claude Code…', click: () => void connectClaude() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: () => void newDialog() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openDialog() },
        {
          label: 'Open Recent',
          submenu: rec.length
            ? [...rec.map((f) => ({ label: `${basename(f)} — ${dirname(f).replace(app.getPath('home'), '~')}`, click: () => void openBoard(f) })), { type: 'separator' as const }, { label: 'Clear Menu', click: () => (writeFileSync(RECENT_FILE, '[]'), app.clearRecentDocuments(), buildMenu()) }]
            : [{ label: 'No recent files', enabled: false }],
        },
        { type: 'separator' },
        {
          label: 'Reveal in Finder',
          click: (_i, w) => {
            const id = [...windows].find(([, x]) => x === w)?.[0];
            const b = id && service.boards.get(id);
            if (b) shell.showItemInFolder(b.file);
          },
        },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Agents',
      submenu: [
        { label: 'Connect Claude Code…', click: () => void connectClaude() },
        { label: 'Copy MCP URL', click: () => clipboard.writeText(`${service.origin}/mcp`) },
        { type: 'separator' },
        { label: 'Show Agent Views (debug)', click: () => views.showAll() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- security

app.on('web-contents-created', (_e, wc) => {
  // no popups; http(s) links open in the default browser
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // the app's pages stay on the app's origin (embedded iframes navigate freely inside themselves)
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(webOrigin() + '/')) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------------------------------------------------------------- start

app.whenReady().then(async () => {
  for (const s of [session.fromPartition('persist:canvas'), session.fromPartition('agent-views')]) s.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  service = new BridgeService({ host: '127.0.0.1', port: Number(process.env.CANVAS_PORT) || 0, staticDir: WEB_DIR, allowOrigins: DEV_WEB ? [DEV_WEB] : [], stateDir: (file) => join(USER, 'boards', boardId(file)), log });
  views = new AgentViews(service, log);
  mcp = new McpEndpoint({ service, views, openBoard, recent });
  service.use(mcp.handle);
  service.use(debugRoutes);
  const port = await service.listen();
  for (const s of [session.fromPartition('persist:canvas'), session.fromPartition('agent-views')])
    s.webRequest.onHeadersReceived({ urls: [`${service.origin}/*`] }, (d, cb) => cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [CSP(port)] } }));
  writeFileSync(ENDPOINT_FILE, JSON.stringify({ pid: process.pid, port, mcp: `${service.origin}/mcp`, started: new Date().toISOString() }, null, 2));
  log(`ready: bridge + web + MCP on ${service.origin} (mcp ${service.origin}/mcp), startup ${Date.now() - T0} ms, electron ${process.versions.electron} node ${process.versions.node}`);
  buildMenu();
  ready = true;
  boardsDir(); // first launch: create the default boards folder
  for (const f of pending.splice(0)) void openBoard(f);
  if (!windows.size && !process.env.CANVAS_NO_DIALOG) void openDialog();
});

// macOS: the app keeps running (hosting boards for agents) with no window open
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (ready && !windows.size) void openDialog();
});
app.on('before-quit', () => {
  log('quit: flushing boards');
  mcp?.closeAll();
  views?.closeAll();
  service?.closeAll();
  try {
    const cur = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'));
    if (cur.pid === process.pid) rmSync(ENDPOINT_FILE);
  } catch {}
});

// ---------------------------------------------------------------- debug routes (spike measurements; localhost only)

async function debugRoutes(_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) {
  if (!url.pathname.startsWith('/app/')) return false;
  const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v, null, 2) + '\n');
  if (url.pathname === '/app/metrics') {
    const m = app.getAppMetrics();
    const kb = m.reduce((s, p) => s + p.memory.workingSetSize, 0);
    const wins = BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), pid: w.webContents.getOSProcessId() }));
    json({ totalMB: Math.round(kb / 1024), processes: m.map((p) => ({ pid: p.pid, type: p.type, name: p.name, serviceName: p.serviceName, MB: Math.round(p.memory.workingSetSize / 1024), privateMB: p.memory.privateBytes ? Math.round(p.memory.privateBytes / 1024) : undefined })), windows: wins, agentViews: views.count(), mcpSessions: mcp.sessions.size });
    return true;
  }
  if (url.pathname === '/app/window-shot') {
    // the person's window for a board, as they see it
    const b = service.find(url.searchParams.get('board') ?? undefined);
    const w = windows.get(b.id);
    if (!w) return json({ error: 'no window' }), true;
    const img = await w.webContents.capturePage(undefined, { stayHidden: true });
    res.writeHead(200, { 'content-type': 'image/png' }).end(img.toPNG());
    return true;
  }
  if (url.pathname === '/app/eval' && _req.method === 'POST' && !app.isPackaged) {
    // dev only: evaluate JS in a board's window (or its first agent view with ?view=1)
    let js = '';
    for await (const c of _req) js += c;
    const b = service.find(url.searchParams.get('board') ?? undefined);
    const w = url.searchParams.get('view') ? BrowserWindow.getAllWindows().find((x) => !x.isVisible() && x.webContents.getURL().includes(b.id)) : windows.get(b.id);
    if (!w) return json({ error: 'no window' }), true;
    try {
      json({ value: await w.webContents.executeJavaScript(js) });
    } catch (e) {
      json({ error: (e as Error).message });
    }
    return true;
  }
  if (url.pathname === '/app/connect') return json(connectCommands()), true;
  return false;
}
