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
  /**
   * A move of objects of this type just ended (after any `onDrop`): a drag (`via: 'drag'`) or an
   * arrow-key nudge (`via: 'keys'`, after every step). Called once per type with that type's moved
   * nodes (current state). `target` = the node they were dropped on, if any. Dispatches made here
   * join the move's undo step.
   */
  onDragEnd?(dragged: CanvasNode[], app: App, target?: string, via?: 'drag' | 'keys'): void;
  /**
   * Not rendered at all for this viewer (no box: can't be seen, hovered or selected), e.g. the private
   * cards of a hand that hides its count from other players.
   */
  concealed?(node: CanvasNode, ctx: RenderCtx): boolean;
  /**
   * A drag of this object stays local until it's released: the object moves only on this screen and
   * nothing is sent while it moves (others see nothing until the drop). Drop on a target = `onDrop` of
   * the target as usual (`app.view.dragBox(id)` gives the dragged spot); drop on nothing = `onLocalDrop`.
   */
  dragsLocally?(node: CanvasNode, app: App): boolean;
  /** A local drag ended on no target, with the object's top-left at `at` (world). */
  onLocalDrop?(node: CanvasNode, at: { x: number; y: number }, app: App): void;
  /** A local drag of this object starts / ends (e.g. to show drop zones). */
  onLocalDrag?(node: CanvasNode, phase: 'start' | 'end', app: App): void;
  /** A drop over this object goes to another one instead (its id), e.g. a card in a hand → the hand. */
  dropProxy?(node: CanvasNode, app: App): string | undefined;
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
  /** A color dot before the label (e.g. a player's color). */
  color?: string;
  /** Greyed text that still runs (e.g. a player who left). */
  muted?: boolean;
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

/** Something a player can put on the table from the Add menu (a deck of cards, a chess set). */
export interface Kit {
  id: string;
  label: string;
  /** Put the kit on the table around world point `at` (the middle of the view). One dispatch = one undo step. */
  create(app: App, at: { x: number; y: number }): void;
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
