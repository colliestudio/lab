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
   * Does this press grab the object? Return false to let it fall through to the table (box select,
   * click-to-deselect), e.g. on a locked board's surface. Default: true.
   */
  grabbable?(node: CanvasNode, down: PointerEvent, app: App): boolean;
  /** Plain click (no drag, no Shift). `down` = the pointerdown. Return true if handled (skips double-click). */
  onClick?(node: CanvasNode, down: PointerEvent, app: App): boolean | void;
  /** A control inside the rendered object (`data-action="name"`) was pressed. Never starts a drag. */
  onAction?(node: CanvasNode, action: string, app: App): void;
  /**
   * A drag of this object alone is starting (pointer moved past the threshold; a plain click never
   * gets here). Return another node id to drag that instead, e.g. a deck hands out its top card.
   * `down` is the original pointerdown (modifiers, which part of the object was grabbed).
   * Dispatches made here join the gesture's undo step.
   */
  onDragStart?(node: CanvasNode, down: PointerEvent, app: App): string | void;
  /** Would this object take `dropped` if they were released on it? (drives the hover highlight) */
  canDrop?(target: CanvasNode, dropped: CanvasNode[], app: App): boolean;
  /** Objects were deliberately dropped onto this one. */
  onDrop?(target: CanvasNode, droppedIds: string[], app: App): void;
  /**
   * A drag that moved objects of this type just ended (after any `onDrop`). Called once per type with
   * that type's dragged nodes (current state). `target` = the node they were dropped on, if any.
   * Dispatches made here join the gesture's undo step.
   */
  onDragEnd?(dragged: CanvasNode[], app: App, target?: string): void;
}

export interface KeyBinding {
  /** e.g. "f", "shift+d", "mod+s" (mod = Cmd on Mac, Ctrl elsewhere), "space". */
  key: string;
  label?: string;
  /**
   * Only when this says so (else the key does what it would without the binding). Lets "space" act
   * on a hovered object instead of starting a pan.
   */
  when?(app: App): boolean;
  run(app: App): void;
}

export interface MenuItem {
  label: string;
  hint?: string;
  when(app: App, selected: CanvasNode[]): boolean;
  run(app: App, selected: CanvasNode[]): void;
}

/** Something a player can put on the table from the Add menu (a deck of cards, a chess set). */
export interface Kit {
  id: string;
  label: string;
  /** Put the kit on the table around world point `at` (the middle of the view). One dispatch = one undo step. */
  create(app: App, at: { x: number; y: number }): void;
}

export interface Plugin {
  id: string;
  setup(app: App): void;
}
