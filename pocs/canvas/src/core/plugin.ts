import type { CanvasNode, DocView } from './doc';
import type { App } from './app';

/** What a renderer may look at. `viewer` = the local player (fog of war will hide things per viewer). */
export interface RenderCtx {
  doc: DocView;
  viewer: string;
}

/** How a kind of object looks and reacts. Core picks the first type whose `match` accepts a node. */
export interface ObjectType {
  id: string;
  match(node: CanvasNode): boolean;
  /** Fill `el` (the positioned node box) with the object's content. */
  render(node: CanvasNode, el: HTMLElement, ctx: RenderCtx): void;
  /**
   * Re-render only when this key changes. Default: the node's fields minus position/z.
   * Override when the look depends on other nodes (a deck depends on its cards).
   */
  renderKey?(node: CanvasNode, ctx: RenderCtx): string;
  onDoubleClick?(node: CanvasNode, app: App): void;
  /**
   * Pointer pressed on this object, before a drag starts. Return another node id to drag that
   * instead (e.g. pull a card off a deck).
   */
  onPointerDown?(node: CanvasNode, e: PointerEvent, app: App): string | void;
  /** Would this object take `dropped` if they were released on it? (drives the hover highlight) */
  canDrop?(target: CanvasNode, dropped: CanvasNode[], app: App): boolean;
  /** Objects were deliberately dropped onto this one. */
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
