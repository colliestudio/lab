import type { Command, LayoutRule, Placement, Store } from '../../core';
import { commands } from './commands';
import { repairImport, shapeExport } from './export';
import { ctypeOf, data, heightOf, isInstance, typeOf } from './model';

/** Cards size themselves from their type and values (derived on read, never stored). */
export const sizeLayout: LayoutRule = (doc) => {
  const out = new Map<string, Placement>();
  for (const n of doc.nodes) {
    if (!isInstance(n)) continue;
    const h = heightOf(typeOf(doc, ctypeOf(n)), data(n), n.width);
    if (h !== n.height) out.set(n.id, { height: h });
  }
  return out;
};

/** The data side of the plugin (no DOM; used by tests and headless agents). */
export function registerComponentsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`components.${name}`, cmd as Command);
  store.addLayout(sizeLayout);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
}
