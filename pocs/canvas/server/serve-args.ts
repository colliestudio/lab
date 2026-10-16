// Arguments of `server/serve.ts`:
//   <dir> [--port N] [--host H] [--allow-origin URL]… [--host-name NAME]… [--idle-ms N] [--mcp-idle-ms N] [--app DIR]
// Also --flag=value. A flag's value is never taken for the folder, whatever the order.

export interface ServeArgs {
  dir: string;
  port?: number;
  host?: string;
  allowOrigins: string[];
  /** Host names the server is reached by (a proxy in front, e.g. mini.internal): each is trusted as Host and as Origin on the server's own port. */
  hostNames: string[];
  /** Unload a board after this long unused (default 10 minutes). */
  idleMs?: number;
  /** Close an MCP session with no request in flight for this long (default 30 minutes). */
  mcpIdleMs?: number;
  /** The built web app to serve (default: the repo's dist). */
  app?: string;
}

const VALUE_FLAGS = new Set(['port', 'host', 'allow-origin', 'host-name', 'idle-ms', 'mcp-idle-ms', 'app']);
const OPTIONS = '--port, --host, --allow-origin, --host-name, --idle-ms, --mcp-idle-ms, --app';

export function parseServeArgs(argv: string[]): ServeArgs {
  const out: Partial<ServeArgs> & { allowOrigins: string[]; hostNames: string[] } = { allowOrigins: [], hostNames: [] };
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
    } else if (name === 'mcp-idle-ms') {
      if (!/^\d+$/.test(value)) throw new Error(`--mcp-idle-ms: "${value}" is not a number of milliseconds`);
      out.mcpIdleMs = Number(value);
    } else if (name === 'idle-ms') {
      if (!/^\d+$/.test(value)) throw new Error(`--idle-ms: "${value}" is not a number of milliseconds`);
      out.idleMs = Number(value);
    } else if (name === 'app') out.app = value;
    else if (name === 'host') out.host = value;
    else if (name === 'host-name') {
      // repeatable, and a comma list works too (launchd passes one argument)
      for (const n of value.split(',')) {
        if (!/^[a-z0-9.-]+$/i.test(n)) throw new Error(`--host-name: "${n}" is not a bare host name (no scheme, port or path; use --allow-origin for those)`);
        out.hostNames.push(n.toLowerCase());
      }
    }
    else out.allowOrigins.push(value);
  }
  if (dirs.length !== 1) throw new Error(dirs.length ? `one folder only, got: ${dirs.join(', ')}` : 'a folder of .canvas files is required');
  return { ...out, dir: dirs[0] };
}
