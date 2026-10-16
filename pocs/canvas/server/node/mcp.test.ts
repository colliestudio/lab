import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { catalog } from '../../bridge/catalog';
import { stableSerialize } from '../core/canonical';
import { BoardDirectory } from '../core/directory';
import { MemoryStorage } from '../core/memory';
import { McpService } from '../mcp/session';
import { sessionTools } from '../mcp/tools';
import { mcpHandler } from './mcp';

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });

let http: Server | undefined;
let dir: BoardDirectory;
let svc: McpService;

async function start(build?: typeof sessionTools) {
  dir = new BoardDirectory(new MemoryStorage({ a: stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } }) }), { sweepMs: 0, log: () => {} });
  svc = new McpService(dir);
  const h = mcpHandler(svc, () => {}, catalog(), build);
  http = createServer((req, res) => void h.handle(req, res));
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(http!.address() as AddressInfo).port}/mcp`;
}

afterEach(async () => {
  svc?.closeAll();
  await dir?.closeAll();
  http?.closeAllConnections();
  http?.close();
});

const init = (url: string, accept: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: INIT });

describe('mcpHandler initialize', () => {
  it('a good initialize starts a session', async () => {
    const url = await start();
    const r = await init(url, 'application/json, text/event-stream');
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
    expect(svc.sessions.size).toBe(1);
    await r.body?.cancel();
  });

  it('an initialize the SDK refuses leaves no session behind', async () => {
    const url = await start();
    for (let i = 0; i < 3; i++) expect((await init(url, 'application/json')).status).toBe(406);
    expect(svc.sessions.size).toBe(0);
  });

  it('a session that cannot be set up leaves none behind and answers 500', async () => {
    const url = await start(() => {
      throw new Error('tool clash');
    });
    expect((await init(url, 'application/json, text/event-stream')).status).toBe(500);
    expect(svc.sessions.size).toBe(0);
  });
});
