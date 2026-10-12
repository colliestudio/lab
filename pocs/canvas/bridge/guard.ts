import type { IncomingHttpHeaders } from 'node:http';

// What the bridge accepts. Binding to 127.0.0.1 keeps other machines out, but not web pages open in
// the user's own browser: they can reach localhost too, post JSON as "text/plain" without a preflight,
// open a WebSocket (no same-origin rule applies) or rebind a DNS name to 127.0.0.1. So a request is
// refused unless
//  - its Host is a loopback name or the host of an allowed origin (DNS rebinding),
//  - its Origin, when it has one, is the bridge's own or an allowed one (cross-site requests and
//    WebSockets). Non-browser clients (CLI, MCP, curl) send no Origin and pass,
//  - a POST says it is JSON (a cross-site form or a simple fetch cannot).
// Reads are guarded too: the chat and the document are private. There are no CORS headers at all:
// the browser app only uses the WebSocket.
// `--as NAME` stays unauthenticated: any local process may act under any name.

export interface Guard {
  /** Reason to refuse, or undefined to let the request through. */
  check(headers: IncomingHttpHeaders, method?: string): string | undefined;
  /** The origins that may talk to the bridge from a browser. */
  origins: string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostname = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();

export function makeGuard(opts: { port: number; allowOrigins?: string[] }): Guard {
  const extra = (opts.allowOrigins ?? []).map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const own = [...LOOPBACK].map((h) => `http://${h}:${opts.port}`);
  const origins = [...new Set([...own, ...extra])];
  const hosts = new Set(LOOPBACK);
  for (const o of extra) {
    try {
      hosts.add(new URL(o).hostname.toLowerCase());
    } catch {
      /* a malformed --allow-origin never matches anything */
    }
  }
  return {
    origins,
    check(headers, method = 'GET') {
      const host = headers.host;
      if (!host || !hosts.has(hostname(host))) return `Host ${host ?? '(none)'} is not allowed`;
      const origin = headers.origin;
      if (origin !== undefined && !origins.includes(origin)) return `Origin ${origin} is not allowed (start the bridge with --allow-origin ${origin})`;
      if (method !== 'GET' && method !== 'HEAD' && !/^application\/json\s*(;|$)/i.test(headers['content-type'] ?? '')) return 'POST needs content-type: application/json';
      return undefined;
    },
  };
}
