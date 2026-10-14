import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

// A Cloudflare quick tunnel to the bridge, so a browser on another machine can reach it:
//   cloudflared tunnel --url http://localhost:<port> --http-host-header localhost:<port>
// The Host rewrite keeps the bridge's DNS-rebinding check (guard.ts) honest: it sees "localhost".
// The URL is public, which is why a shared bridge has a pairing token.

export interface Tunnel {
  /** https://<random>.trycloudflare.com */
  url: string;
  stop(): void;
}

type Spawn = (cmd: string, args: string[]) => Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'kill'>;

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export function startTunnel(port: number, opts: { spawn?: Spawn; bin?: string; timeoutMs?: number } = {}): Promise<Tunnel> {
  const bin = opts.bin ?? 'cloudflared';
  const spawn: Spawn = opts.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] }));
  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--http-host-header', `localhost:${port}`, '--no-autoupdate']);
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(`${why}${output ? `\n${output.trim().split('\n').slice(-5).join('\n')}` : ''}`));
    };
    const timer = setTimeout(() => fail(`no tunnel URL from ${bin} after ${(opts.timeoutMs ?? 30_000) / 1000}s`), opts.timeoutMs ?? 30_000);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const m = URL_RE.exec(output);
      if (!m || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: m[0], stop: () => void child.kill() });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? `${bin} not found (brew install cloudflared), or run without a tunnel: --no-tunnel` : `${bin}: ${e.message}`));
    child.on('exit', (code: number | null) => fail(`${bin} exited (${code}) before it gave a URL`));
  });
}
