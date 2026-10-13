import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Boards in iCloud Drive can be evicted ("dataless" placeholders). Reading a dataless file makes
// macOS download it first, which blocks; so read it here, off the main loop, before the bridge's own
// synchronous read. Older systems leave a `.name.icloud` stub instead; `brctl download` fetches it.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureLocal(file: string, timeoutMs = 30_000): Promise<void> {
  const stub = join(dirname(file), `.${basename(file)}.icloud`);
  if (!existsSync(file) && existsSync(stub)) {
    await new Promise<void>((ok) => execFile('brctl', ['download', file], () => ok()));
    for (let t = 0; t < timeoutMs && !existsSync(file); t += 250) await sleep(250);
    return;
  }
  if (existsSync(file)) await Promise.race([readFile(file).catch(() => undefined), sleep(timeoutMs)]);
}
