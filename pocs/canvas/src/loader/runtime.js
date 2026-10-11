// The sandbox side of the bridge. Runs inside the plugin's sandboxed iframe (inlined as text by
// sandbox.ts) and in-process in tests. Plain JS, self-contained: no imports, nothing from outside
// this function. It loads nothing itself; it only adapts a plugin module to the message protocol.
//
// host -> sandbox: { t: 'call', id, fn: 'command' | 'render', name?, type?, args?, doc?, node?, ctx }
// sandbox -> host: { t: 'ready', decl } once; { t: 'reply', id, ok, value? , error? } per call

function createRuntime(plugin, post) {
  const p = plugin || {};
  const types = p.types || {};
  const commands = p.commands || {};
  const str = (v) => (v === undefined ? undefined : String(v));
  const decl = {
    types: Object.keys(types).map((id) => ({ id, actions: Object.assign({}, types[id].actions || {}), size: types[id].size })),
    commands: Object.keys(commands),
    kits: (p.kits || []).map((k) => ({ id: String(k.id), label: String(k.label), command: String(k.command) })),
    menu: (p.menu || []).map((m) => ({
      label: String(m.label),
      command: String(m.command),
      type: str(m.type),
      min: m.min,
      max: m.max,
      group: str(m.group),
      prompt: str(m.prompt),
      args: m.args ? JSON.parse(JSON.stringify(m.args)) : undefined,
    })),
  };
  const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const ctxOf = (c) => ({ viewer: c && c.viewer, actor: c && c.actor, now: () => (c && c.now) || Date.now(), newId: hex, random: Math.random });
  const docOf = (d) => {
    const nodes = (d && d.nodes) || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return { nodes, get: (id) => byId.get(id), topZ: nodes.reduce((z, n) => Math.max(z, n.z || 0), 0) };
  };
  async function handle(m) {
    if (!m || m.t !== 'call') return;
    try {
      let value;
      if (m.fn === 'command') {
        const f = commands[m.name];
        if (typeof f !== 'function') throw new Error('unknown command ' + m.name);
        value = await f(docOf(m.doc), m.args, ctxOf(m.ctx));
        if (Array.isArray(value)) value = { changes: value };
      } else if (m.fn === 'render') {
        const t = types[m.type];
        value = t && typeof t.render === 'function' ? await t.render(m.node, ctxOf(m.ctx)) : null;
      } else throw new Error('unknown call ' + m.fn);
      post({ t: 'reply', id: m.id, ok: true, value: JSON.parse(JSON.stringify(value === undefined ? null : value)) });
    } catch (e) {
      post({ t: 'reply', id: m.id, ok: false, error: String((e && e.message) || e) });
    }
  }
  post({ t: 'ready', decl });
  return { handle };
}

export { createRuntime };
