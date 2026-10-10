import type { CanvasNode } from './doc';
import type { App } from './app';

/** How a kind of object looks and reacts. Core picks the first type whose `match` accepts a node. */
export interface ObjectType {
  id: string;
  match(node: CanvasNode): boolean;
  /** Fill `el` (the positioned node box) with the object's content. Called when non-position data changes. */
  render(node: CanvasNode, el: HTMLElement): void;
  onDoubleClick?(node: CanvasNode, app: App): void;
  /**
   * Pointer pressed on this object, before a drag starts. Return another node id to drag that
   * instead (e.g. pull a card off a stack).
   */
  onPointerDown?(node: CanvasNode, e: PointerEvent, app: App): string | void;
  /** Other objects were dropped onto this one. */
  onDrop?(target: CanvasNode, droppedIds: string[], app: App): void;
}

export interface KeyBinding {
  /** e.g. "f", "shift+d", "mod+s" (mod = Cmd on Mac, Ctrl elsewhere). */
  key: string;
  label?: string;
  run(app: App): void;
}

export interface MenuItem {
  label: string;
  hint?: string;
  when(app: App, selected: CanvasNode[]): boolean;
  run(app: App, selected: CanvasNode[]): void;
}

export interface Plugin {
  id: string;
  setup(app: App): void;
}
