// Dev sandbox origin: serves the frame host (src/sandbox/framehost.js) on its own port, so plugin
// and page frames load from a different origin than the app, with real HTTP headers.
//
//   node sandbox/server.mjs [--port 5227] [--sink]
//
// Frames use one subdomain each: http://<label>.localhost:5227/worker (Chrome, Firefox and Safari
// resolve *.localhost to loopback) or http://<label>.mini.internal:5227 through the Mini dev proxy.
// --sink also records requests to /__sink/* and UDP packets on the same port number, for the attack
// demo: GET /__sink/log lists what leaked (JSON, any origin may read it; dev only).
// Env: SANDBOX_APP_ORIGINS="http://localhost:* https://…" (who may embed; default: dev hosts).

import http from 'node:http';
import dgram from 'node:dgram';
import { frameHost } from '../src/sandbox/framehost.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt('--port', process.env.SANDBOX_PORT ?? 5227));
const sink = flag('--sink');
const host = frameHost({ appOrigins: process.env.SANDBOX_APP_ORIGINS?.split(/\s+/).filter(Boolean) });

const hits = [];
const record = (kind, what) => {
  hits.push({ kind, what: String(what).slice(0, 300), at: Date.now() });
  if (hits.length > 200) hits.shift();
};

function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (sink && url.pathname === '/__sink/log') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(hits));
  }
  if (sink && url.pathname === '/__sink/clear') {
    hits.length = 0;
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }
  if (sink && url.pathname.startsWith('/__sink/')) {
    record('http', `${req.method} ${url.pathname.slice(7)}${url.search}`);
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    return res.end('leaked to the sink\n');
  }
  const r = host.serve(url.pathname, url.search);
  res.writeHead(r.status, r.headers);
  res.end(r.body);
}

// both loopback families: *.localhost may resolve to either
for (const addr of ['127.0.0.1', '::1']) {
  const s = http.createServer(handler);
  s.on('error', (e) => console.error(`[sandbox] ${addr}: ${e.message}`));
  s.listen(port, addr);
}
if (sink) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, from) => record('udp', `${msg.length} bytes from ${from.address}:${from.port}`));
  udp.on('error', (e) => console.error(`[sandbox] udp: ${e.message}`));
  udp.bind(port, '127.0.0.1');
}
console.log(`[sandbox] frame host on http://<label>.localhost:${port} (apps: ${host.appOrigins.join(' ')})${sink ? ' + sink' : ''}`);
