import type { CanvasNode } from './doc';
import type { KeyBinding, Tool } from './plugin';

/**
 * The creation tool a plain letter picks, if any. Keys are shared between plugins, so context decides:
 * with the pointer over some other plugin's object that plugin's key wins (S shuffles the deck under
 * the pointer), and so does a plugin binding that applies right now. Otherwise the tool takes it.
 * (A selection also keeps the letters for plugins and typing: the caller only asks with none.)
 */
export function toolForKey(
  tools: readonly Tool[],
  keys: ReadonlyMap<string, KeyBinding>,
  key: string,
  hovered: CanvasNode | undefined,
  app: Parameters<NonNullable<Tool['when']>>[0],
): Tool | undefined {
  const tool = tools.find((t) => t.key === key && t.when?.(app) !== false);
  if (!tool) return undefined;
  if (hovered && !tool.owns?.(hovered)) return undefined;
  if (keys.get(key)?.when?.(app)) return undefined;
  return tool;
}
