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
  /**
   * Would this object take `dropped` if released now? `overlap` = intersection over the smaller box
   * (0..1). Return false to refuse, true to accept, or a short mode label (e.g. "Stack", "Fan") that
   * is shown on the target while hovering and passed to `onDrop`. Without `canDrop`, core accepts at
   * ≥50% overlap.
   */
  canDrop?(target: CanvasNode, dropped: CanvasNode[], app: App, overlap: number): boolean | string;
  /** Objects were deliberately dropped onto this one. */
  /** `at` = the drop point in world coordinates (e.g. to insert at a position in a layout). */
  onDrop?(target: CanvasNode, droppedIds: string[], app: App, at: { x: number; y: number }, mode?: string): void;
}

export interface KeyBinding {
  /** e.g. "f", "shift+d", "mod+s" (mod = Cmd on Mac, Ctrl elsewhere). */
  key: string;
  label?: string;
  run(app: App): void;
}

/** One row of a (context or tab) menu. */
export interface MenuEntry {
  label: string;
  /** Keyboard shortcut, shown on the right (e.g. "F", "⇧G"). */
  hint?: string;
  run?: () => void;
  /** A submenu ("Label ▸"); a function is built when it opens. */
  items?: MenuEntry[] | (() => MenuEntry[]);
  /** Checkmark state (omit for plain items). */
  checked?: boolean;
  /** Greyed out; a string is the reason, shown under the label. */
  disabled?: boolean | string;
  /** Draw a separator line above this row. */
  separator?: boolean;
  /** A number field with a button (e.g. "Deal N"): runs with the typed number. */
  number?: { value?: number; min?: number; max?: number; action?: string; run(n: number): void };
}

export interface MenuItem {
  label: string;
  hint?: string;
  when(app: App, selected: CanvasNode[]): boolean;
  run(app: App, selected: CanvasNode[]): void;
}

/**
 * Builds the right-click menu for the selection (empty = the table). Providers' entries are joined
 * with separators; `title` (first one given wins) heads the menu, e.g. the kind of object.
 */
export type MenuProvider = (app: App, selected: CanvasNode[]) => { title?: string; entries: MenuEntry[] } | undefined;

export interface Plugin {
  id: string;
  setup(app: App): void;
}
