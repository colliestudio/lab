import type { App } from '../../core';
import { CARD_W } from './model';

/** Cards being edited on this device (local, like a selection). */
export const editing = new Set<string>();

export function setEditing(app: App, id: string, on: boolean) {
  if (on) editing.add(id);
  else editing.delete(id);
  app.view.render();
  if (on) app.view.boxOf(id)?.querySelector<HTMLElement>('.cmp-input')?.focus();
}

/** New instance centered near world point `at` (top part), opened for editing. */
export function addInstance(app: App, type: string, at: { x: number; y: number }, edit = true) {
  const id = app.dispatch('components.create', { type, x: at.x - CARD_W / 2, y: at.y - 60 }).select?.[0];
  if (id && edit) setEditing(app, id, true);
  return id;
}
