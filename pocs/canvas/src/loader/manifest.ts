import { sha256Hex } from '../sandbox/sha256.js';

// Third-party plugin manifest: what a plugin is and what it may do. Read (never executed) before
// install, shown to the user for consent, recorded in the room so peers load the same set.

/**
 * Capabilities a plugin can ask for. Everything not granted is denied by the host bridge.
 * (always) a plugin sees its own nodes: those carrying its `x-<id>` namespace
 * - nodes:read:all  read every node the local viewer may see (hidden ones come redacted)
 * - nodes:write     add / change / delete its own nodes (own namespace + geometry/text/color)
 * - ui:kit          put entries in the Add menu
 * - ui:menu         put entries in the right-click menu
 * - log:write       write to the shared event log
 * - network:none    no network at all (the default; the sandbox CSP blocks fetch / WebSocket)
 * - network:<origin> may connect to that origin only, e.g. network:https://api.example.com
 */
export const CAPS = ['nodes:read:all', 'nodes:write', 'ui:kit', 'ui:menu', 'log:write', 'network:none'] as const;
export type Cap = (typeof CAPS)[number] | `network:${string}`;

export const CAP_TEXT: Record<string, string> = {
  'nodes:read:all': 'read everything you can see on the table',
  'nodes:write': 'create and change its own objects',
  'ui:kit': 'add items to the Add menu',
  'ui:menu': 'add right-click menu items',
  'log:write': 'write to the table log',
  'network:none': 'no network access',
};
export const capText = (c: string) => CAP_TEXT[c] ?? (c.startsWith('network:') ? `connect to ${c.slice(8)}` : c);

export interface Manifest {
  /** Namespace: lowercase, also the node field `x-<id>` and the log type prefix `<id>.`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Module file, relative to the manifest URL. */
  main: string;
  capabilities: Cap[];
}

/** Namespaces the built-in plugins and core own: a third-party plugin can't take them. */
export const RESERVED = new Set(['core', 'app', 'cards', 'chess', 'clock', 'mats', 'battleline', 'ext', 'plugins']);

const ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Validate untrusted JSON into a Manifest, or throw with a reason. */
export function parseManifest(raw: unknown): Manifest {
  const m = raw as Partial<Manifest> | null;
  if (!m || typeof m !== 'object') throw new Error('manifest: not an object');
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error('manifest: id must match ' + ID);
  if (RESERVED.has(m.id)) throw new Error(`manifest: id "${m.id}" is reserved`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) throw new Error('manifest: bad name');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) throw new Error('manifest: version must be semver');
  if (typeof m.main !== 'string' || !/\.m?js$/.test(m.main)) throw new Error('manifest: main must be a .js file');
  if (!Array.isArray(m.capabilities)) throw new Error('manifest: capabilities must be a list');
  for (const c of m.capabilities) {
    if (typeof c !== 'string') throw new Error('manifest: bad capability');
    if ((CAPS as readonly string[]).includes(c)) continue;
    if (c.startsWith('network:') && isOrigin(c.slice(8))) continue;
    throw new Error(`manifest: unknown capability "${c}"`);
  }
  const nets = m.capabilities.filter((c) => c.startsWith('network:'));
  if (nets.includes('network:none') && nets.length > 1) throw new Error('manifest: network:none with other network capabilities');
  return {
    id: m.id,
    name: m.name.trim(),
    version: m.version,
    description: typeof m.description === 'string' ? m.description.slice(0, 200) : undefined,
    main: m.main,
    capabilities: [...new Set(m.capabilities)],
  };
}

function isOrigin(s: string) {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'wss:') && u.origin === s;
  } catch {
    return false;
  }
}

export const has = (m: Pick<Manifest, 'capabilities'>, c: Cap) => m.capabilities.includes(c);
/** Origins the sandbox may connect to (empty = none). */
export const networkOrigins = (m: Manifest) => m.capabilities.filter((c) => c.startsWith('network:') && c !== 'network:none').map((c) => c.slice(8));

/** Content hash of the plugin code: what a room pins and what a device approves. */
export async function hashSource(src: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(src));
    return 'sha256-' + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // plain-http pages (http://mini.internal:…) have no crypto.subtle: the same SHA-256 in plain JS,
  // so pinning holds there too and both kinds of device agree on the hash
  return 'sha256-' + sha256Hex(src);
}
