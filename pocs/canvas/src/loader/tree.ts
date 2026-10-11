// Declarative render trees: how a sandboxed plugin draws. The plugin returns plain data; the host
// turns it into HTML through an allowlist (tags, classes, a few style properties, no URLs, no
// handlers). Interactive bits are `action` names: the host puts them in `data-action`, the core
// view's existing onAction path sends them back to the plugin.

export interface RenderNode {
  tag?: string;
  text?: string | number;
  /** Space separated, each must be `[a-z0-9-]+`; prefixed `px-<plugin>-` on output. */
  class?: string;
  style?: Record<string, string | number>;
  /** Pressing this element runs the plugin's action (never starts a drag). */
  action?: string;
  title?: string;
  children?: RenderTree[];
}
export type RenderTree = RenderNode | string | number | null | undefined | false;

const TAGS = new Set(['div', 'span', 'b', 'i', 'em', 'strong', 'small', 'p', 'button', 'ul', 'li']);
/** Style properties a plugin may set; values are checked against SAFE_VALUE. */
const STYLES = new Set([
  'color', 'background', 'background-color', 'border', 'border-radius', 'border-color', 'font-size', 'font-weight',
  'text-align', 'padding', 'margin', 'display', 'flex-direction', 'align-items', 'justify-content', 'gap',
  'width', 'height', 'opacity', 'line-height', 'grid-template-columns', 'place-items', 'transform', 'box-shadow',
  'white-space', 'overflow', 'cursor', 'font-family', 'letter-spacing', 'flex', 'min-width',
]);
/** No url(), expressions, escapes or other at-rule tricks: plain words, numbers, colors, units. */
const SAFE_VALUE = /^[\w\s#%.,()+-]*$/;
const CLASS = /^[a-z0-9-]+$/;
const ACTION = /^[\w.-]{1,40}$/;
const MAX_NODES = 2000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sanitized HTML for a plugin's render tree. No tag = div, unknown tags become spans; unsafe bits are dropped. */
export function treeToHtml(tree: RenderTree, pluginId: string): string {
  let budget = MAX_NODES;
  const walk = (t: RenderTree, depth: number): string => {
    if (t === null || t === undefined || t === false) return '';
    if (typeof t === 'string' || typeof t === 'number') return esc(String(t));
    if (typeof t !== 'object' || --budget < 0 || depth > 30) return '';
    const tag = t.tag === undefined ? 'div' : typeof t.tag === 'string' && TAGS.has(t.tag) ? t.tag : 'span';
    const attrs: string[] = [];
    const classes = typeof t.class === 'string' ? t.class.split(/\s+/).filter((c) => CLASS.test(c)) : [];
    if (classes.length) attrs.push(`class="${classes.map((c) => `px-${pluginId}-${c}`).join(' ')}"`);
    if (t.style && typeof t.style === 'object') {
      const css = Object.entries(t.style)
        .filter(([k, v]) => STYLES.has(k) && (typeof v === 'number' || (typeof v === 'string' && SAFE_VALUE.test(v) && !/url|expression/i.test(v))))
        .map(([k, v]) => `${k}:${v}`)
        .join(';');
      if (css) attrs.push(`style="${esc(css)}"`);
    }
    if (typeof t.action === 'string' && ACTION.test(t.action)) attrs.push(`data-action="${esc(t.action)}"`);
    if (typeof t.title === 'string') attrs.push(`title="${esc(t.title.slice(0, 200))}"`);
    if (tag === 'button') attrs.push('type="button"');
    const inner = (t.text !== undefined ? esc(String(t.text)) : '') + (Array.isArray(t.children) ? t.children.map((c) => walk(c, depth + 1)).join('') : '');
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`;
  };
  return walk(tree, 0);
}
