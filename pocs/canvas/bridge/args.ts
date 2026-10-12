// Arguments of `bridge/server.ts`: [file] [--port N] [--host H] [--allow-origin URL]… (also --flag=value).
// A flag's value is never taken for the file, whatever the order.

export interface BridgeArgs {
  file: string;
  port?: number;
  host?: string;
  allowOrigins: string[];
}

const VALUE_FLAGS = new Set(['port', 'host', 'allow-origin']);

export function parseBridgeArgs(argv: string[]): BridgeArgs {
  const out: BridgeArgs = { file: 'board.canvas', allowOrigins: [] };
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      files.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name} (options: --port, --host, --allow-origin)`);
    const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'port') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port: "${value}" is not a port`);
      out.port = n;
    } else if (name === 'host') out.host = value;
    else out.allowOrigins.push(value);
  }
  if (files.length > 1) throw new Error(`one file only, got: ${files.join(', ')}`);
  if (files[0]) out.file = files[0];
  return out;
}
