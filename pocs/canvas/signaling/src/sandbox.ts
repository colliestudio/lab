import { frameHost } from '../../src/sandbox/framehost.js';

// The sandbox origin on Cloudflare: any `<label>.<SANDBOX_HOST>` request gets the frame host
// (src/sandbox/framehost.js, the same code the dev server on 5227 runs). Everything else falls
// through to the app / signaling. Not deployed; config in ideas/prototype.md.

let cached: { key: string; host: ReturnType<typeof frameHost> } | undefined;

export function sandboxResponse(url: URL, env: { SANDBOX_HOST?: string; APP_ORIGINS?: string }): Response | undefined {
  const base = env.SANDBOX_HOST?.toLowerCase();
  if (!base || !url.hostname.endsWith('.' + base)) return undefined;
  const label = url.hostname.slice(0, -base.length - 1);
  if (!/^[a-z0-9-]{1,63}$/.test(label)) return new Response('bad frame label\n', { status: 400 });
  const apps = (env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean);
  if (!apps.length) return new Response('sandbox origin: APP_ORIGINS not configured\n', { status: 500 });
  const key = apps.join(' ');
  if (cached?.key !== key) cached = { key, host: frameHost({ appOrigins: apps }) };
  const r = cached.host.serve(url.pathname, url.search);
  return new Response(r.body, { status: r.status, headers: r.headers });
}
