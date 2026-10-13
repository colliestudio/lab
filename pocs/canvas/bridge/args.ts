// Arguments of `bridge/server.ts`:
//   [file] [--port N] [--host H] [--allow-origin URL]… [--join ROOM] [--signal URL] [--share] [--no-tunnel] [--app URL] [--token T]
//   share [file]       = --share (tunnel, pairing token, the link to send)
//   join ROOM [file]   = --join ROOM (the bridge enters an existing room)
// Also --flag=value. A flag's value is never taken for the file, whatever the order.

export interface BridgeArgs {
  file: string;
  /** False when the file is the default (join mode names it after the room). */
  fileGiven: boolean;
  port?: number;
  host?: string;
  allowOrigins: string[];
  /** Room link or id to join as a peer (outbound; no inbound port needed). */
  join?: string;
  /** Signaling server for --join when the room is given as a bare id. */
  signal?: string;
  /** Print links for a remote browser: quick tunnel + pairing token. */
  share?: true;
  noTunnel?: true;
  /** The app the link points at (default https://canvas.lab.collie.studio). */
  app?: string;
  token?: string;
}

const VALUE_FLAGS = new Set(['port', 'host', 'allow-origin', 'join', 'signal', 'app', 'token']);
const BOOL_FLAGS = new Set(['share', 'no-tunnel']);
const OPTIONS = '--port, --host, --allow-origin, --join, --signal, --share, --no-tunnel, --app, --token';

export function parseBridgeArgs(argv: string[]): BridgeArgs {
  const out: BridgeArgs = { file: 'board.canvas', fileGiven: false, allowOrigins: [] };
  const files: string[] = [];
  let args = argv;
  let wantsRoom = false;
  if (args[0] === 'share') {
    out.share = true;
    args = args.slice(1);
  } else if (args[0] === 'join') {
    wantsRoom = true;
    args = args.slice(1);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) throw new Error(`unknown option ${a} (options: ${OPTIONS})`);
    if (!a.startsWith('--')) {
      if (wantsRoom && !out.join) out.join = a;
      else files.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) throw new Error(`--${name} takes no value`);
      if (name === 'share') out.share = true;
      else out.noTunnel = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name} (options: ${OPTIONS})`);
    const value = eq < 0 ? args[++i] : a.slice(eq + 1);
    // empty counts as missing: `--host=` would otherwise bind every interface
    if (!value || (eq < 0 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'port') {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n > 65535) throw new Error(`--port: "${value}" is not a port`);
      out.port = n;
    } else if (name === 'host') out.host = value;
    else if (name === 'allow-origin') out.allowOrigins.push(value);
    else if (name === 'join') out.join = value;
    else if (name === 'signal') out.signal = value;
    else if (name === 'app') out.app = value;
    else out.token = value;
  }
  if (wantsRoom && !out.join) throw new Error('join needs a room link or id');
  if (files.length > 1) throw new Error(`one file only, got: ${files.join(', ')}`);
  if (files[0]) {
    out.file = files[0];
    out.fileGiven = true;
  }
  if (out.noTunnel && !out.share) throw new Error('--no-tunnel only makes sense with share');
  return out;
}
