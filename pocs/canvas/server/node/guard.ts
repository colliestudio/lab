import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// What the bridge accepts. Binding to 127.0.0.1 keeps other machines out, but not web pages open in
// the user's own browser: they can reach localhost too, post JSON as "text/plain" without a preflight,
// open a WebSocket (no same-origin rule applies) or rebind a DNS name to 127.0.0.1. So a request is
// refused unless
//  - its Host is a loopback name or the host of an allowed origin (DNS rebinding),
//  - its Origin, when it has one, is the bridge's own or an allowed one (cross-site requests and
//    WebSockets). Non-browser clients (CLI, MCP, curl) send no Origin and pass,
//  - without an Origin, it isn't a browser's request from another site (an <img> or <script> GET
//    sends no Origin, but browsers mark it with Sec-Fetch-Site): reads have effects here too (they
//    seat the actor and mark its chat as read),
//  - a POST (or any other method that sends a body) says it is JSON (a cross-site form or a simple fetch cannot).
// Reads are guarded too: the chat and the document are private. There are no CORS headers at all:
// the browser app only uses the WebSocket.
// `--as NAME` stays unauthenticated: any local process may act under any name.
//
// A shared bridge (reachable through a quick tunnel, which is public) also has a pairing token. A
// request needs it unless it comes straight from this machine: a loopback peer address and none of the
// headers a proxy adds (cloudflared and Caddy both do), so the local CLI and agents need nothing, while
// anything that arrived through a tunnel does. The token is `?token=` on the URL (browsers cannot set
// WebSocket headers) or `Authorization: Bearer`.

export interface RequestInfo {
  /** Request target (path and query), for ?token=. */
  url?: string;
  /** Peer address of the socket. */
  remote?: string;
}

export interface Guard {
  /** Reason to refuse, or undefined to let the request through. */
  check(headers: IncomingHttpHeaders, method?: string, info?: RequestInfo): string | undefined;
  /** Whether the Host header names a loopback name or an allowed origin's host (DNS rebinding). */
  hostAllowed(headers: IncomingHttpHeaders): boolean;
  /** The origins that may talk to the bridge from a browser. */
  origins: string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostname = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'cf-visitor'];
const isLoopback = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function makeGuard(opts: { port: number; allowOrigins?: string[]; token?: string }): Guard {
  // http(s) origins only, as browsers send them: "null" (sandboxed iframes, file://) or a malformed value never matches
  const extra = (opts.allowOrigins ?? []).flatMap((o) => {
    try {
      const u = new URL(o.trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? [u] : [];
    } catch {
      return [];
    }
  });
  const own = [...LOOPBACK].map((h) => `http://${h}:${opts.port}`);
  const origins = [...new Set([...own, ...extra.map((u) => u.origin)])];
  const hosts = new Set(LOOPBACK);
  for (const u of extra) hosts.add(u.hostname.toLowerCase());
  const hostAllowed = (headers: IncomingHttpHeaders) => !!headers.host && hosts.has(hostname(headers.host));
  return {
    origins,
    hostAllowed,
    check(headers, method = 'GET', info = {}) {
      if (opts.token && !(isLoopback(info.remote) && !PROXY_HEADERS.some((h) => headers[h] !== undefined))) {
        const auth = /^Bearer (.+)$/i.exec(String(headers.authorization ?? ''))?.[1];
        let given = auth;
        try {
          given ??= new URL(info.url ?? '/', 'http://bridge').searchParams.get('token') ?? undefined;
        } catch {
          /* malformed target: no token */
        }
        if (!given || !same(given, opts.token)) return 'this bridge needs its pairing token (use the link the bridge printed)';
      }
      if (!hostAllowed(headers)) return `Host ${headers.host ?? '(none)'} is not allowed`;
      const origin = headers.origin;
      if (origin !== undefined && !origins.includes(origin)) return `Origin ${origin} is not allowed${origin.startsWith('http') ? ` (start the bridge with --allow-origin ${origin})` : ''}`;
      const site = headers['sec-fetch-site'];
      if (origin === undefined && site !== undefined && site !== 'none' && site !== 'same-origin') return `a ${site} browser request without an Origin is not allowed`;
      // DELETE carries no body (MCP session close) and a browser cannot send it cross-site without a preflight we never answer
      if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && !/^application\/json\s*(;|$)/i.test(headers['content-type'] ?? '')) return `${method} needs content-type: application/json`;
      return undefined;
    },
  };
}
