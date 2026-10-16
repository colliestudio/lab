// Arguments of `server/serve.ts`:
//   <dir> [--port N] [--host H] [--allow-origin URL]… [--idle-ms N]
// Also --flag=value. A flag's value is never taken for the folder, whatever the order.

export interface ServeArgs {
  dir: string;
  port?: number;
  host?: string;
  allowOrigins: string[];
  /** Unload a board after this long unused (default 10 minutes). */
  idleMs?: number;
}

const VALUE_FLAGS = new Set(['port', 'host', 'allow-origin', 'idle-ms']);
const OPTIONS = '--port, --host, --allow-origin, --idle-ms';

export function parseServeArgs(argv: string[]): ServeArgs {
  const out: Partial<ServeArgs> & { allowOrigins: string[] } = { allowOrigins: [] };
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) throw new Error(`unknown option ${a} (options: ${OPTIONS})`);
    if (!a.startsWith('--')) {
      dirs.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name} (options: ${OPTIONS})`);
    const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
    // empty counts as missing: `--host=` would otherwise bind every interface
    if (!value || (eq < 0 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'port') {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n > 65535) throw new Error(`--port: "${value}" is not a port`);
      out.port = n;
    } else if (name === 'idle-ms') {
      if (!/^\d+$/.test(value)) throw new Error(`--idle-ms: "${value}" is not a number of milliseconds`);
      out.idleMs = Number(value);
    } else if (name === 'host') out.host = value;
    else out.allowOrigins.push(value);
  }
  if (dirs.length !== 1) throw new Error(dirs.length ? `one folder only, got: ${dirs.join(', ')}` : 'a folder of .canvas files is required');
  return { ...out, dir: dirs[0] };
}
