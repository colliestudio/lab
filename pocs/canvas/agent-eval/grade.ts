import type { DocView } from '../src/core/doc';
import { parse } from '../src/core/io';
import { Store } from '../src/core/store';
import { registerCoreCommands } from '../src/core/commands';
import { registerPluginLogic } from '../src/plugins/logic';

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  /** What the grader saw: makes a false fail visible. */
  detail: string;
  /** Shown, but not counted toward pass or x/y. */
  info?: boolean;
}

export const check = (id: string, label: string, pass: boolean, detail: string, info = false): Check => ({ id, label, pass, detail, ...(info ? { info } : {}) });

/** The doc as the plugins see it (same setup as the bridge host). */
export function loadDoc(text: string): DocView {
  const store = new Store();
  registerCoreCommands(store);
  registerPluginLogic(store);
  store.load(parse(text));
  return store.doc;
}

export const quoteList = (xs: string[], max = 12) => (xs.length ? xs.slice(0, max).map((x) => `“${x}”`).join(', ') + (xs.length > max ? `, … (${xs.length})` : '') : 'none');
