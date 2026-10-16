import './assets';
import '@excalidraw/excalidraw/index.css';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptureUpdateAction, Excalidraw, exportToSvg, getCommonBounds, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { PAD, type XElement } from './logic';

// The heavy half (React + Excalidraw, ~1.5 MB): loaded on first use (a drawing on the table or
// opened). Plain functions so the rest of the plugin stays framework-free.

type Els = Parameters<typeof restoreElements>[0];
const restore = (els: XElement[]) => restoreElements(els as unknown as Els, null, { refreshDimensions: false, repairBindings: true });

/** The drawing as an SVG at 1:1, and the scene point its top-left corner shows. */
export async function renderSvg(els: XElement[]): Promise<{ svg: SVGSVGElement; x: number; y: number }> {
  const elements = restore(els);
  const [x, y] = getCommonBounds(elements.filter((e) => !e.isDeleted));
  const svg = await exportToSvg({
    elements,
    appState: { exportBackground: false, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files: null,
    exportPadding: PAD,
  });
  return { svg, x: x - PAD, y: y - PAD };
}

/** Excalidraw's camera: screen = (scene + scroll) * zoom, relative to its container. */
export interface Camera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface EditorHandle {
  /** The stored elements changed (someone else, an agent, an undo on the table): merge them in. */
  remote(stored: XElement[]): void;
  /** Send pending edits now and unmount. */
  close(): void;
  /** Move Excalidraw's camera (in place: the table moved, or the drawing did). */
  camera(c: Camera): void;
  /** Nothing in progress: no selection, no shape or text being made, the select tool. */
  idle(): boolean;
  /** The tool in use (to come back to it next time). */
  tool(): string;
  /** Let go of the selection, if that's all that is going on (Esc). True if it did. */
  deselect(): boolean;
}

type State = ReturnType<ExcalidrawImperativeAPI['getAppState']>;
/** Select tool, nothing being drawn or typed, no dialog, menu or sidebar of Excalidraw's open. */
const canLeave = (s: State) =>
  !s.editingTextElement && !s.newElement && s.activeTool.type === 'selection' && !s.openDialog && !s.openSidebar && !s.openMenu && !s.openPopup && !s.contextMenu;

const key = (e: { version: number; versionNonce: number }) => `${e.version}:${e.versionNonce}`;

/**
 * Mount the full Excalidraw editor in `host`. Local edits go out through `onLocal` (only elements
 * whose version changed, batched per frame); `remote` brings the doc's changes in, outside
 * Excalidraw's own undo history.
 */
export function mountEditor(
  host: HTMLElement,
  o: {
    elements: XElement[];
    onLocal(changed: XElement[]): void;
    onDone(): void;
    title: string;
    /** In place in a frame: this camera, changes reported (else full screen, fit to content). */
    inPlace?: { camera: Camera; onCamera(c: Camera): void };
    /** Start with this Excalidraw tool (rectangle, ellipse, arrow, freedraw…). */
    tool?: string;
    /** Look, don't touch (a locked frame full screen). */
    viewOnly?: boolean;
  },
): EditorHandle {
  /** Version we last sent or received per element: an onChange with the same one is an echo. */
  const known = new Map<string, string>();
  for (const e of o.elements) known.set(e.id, key(e));
  let api: ExcalidrawImperativeAPI | null = null;
  let pending = new Map<string, XElement>();
  let frame = 0;
  let queued: XElement[] | null = null;

  const flush = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!pending.size) return;
    const out = [...pending.values()];
    pending = new Map();
    o.onLocal(out);
  };
  const onChange = (els: readonly { id: string; version: number; versionNonce: number }[]) => {
    for (const e of els) {
      const k = key(e);
      if (known.get(e.id) === k) continue;
      known.set(e.id, k);
      pending.set(e.id, JSON.parse(JSON.stringify(e)) as XElement);
    }
    if (pending.size && !frame) frame = requestAnimationFrame(flush);
  };
  /**
   * The doc is the truth: every stored element that changed since we last saw it replaces ours,
   * even with a lower version (a table undo takes versions back), unless we have an edit of it
   * still on its way out (that edit then wins, see `excalidraw.put`). Elements gone from the doc
   * (an undone add) leave the scene.
   */
  const remote = (stored: XElement[]) => {
    if (!api) {
      queued = stored;
      return;
    }
    const inDoc = new Set(stored.map((e) => e.id));
    const incoming = stored.filter((e) => known.get(e.id) !== key(e) && !pending.has(e.id));
    const gone = [...known.keys()].filter((id) => !inDoc.has(id) && !pending.has(id));
    if (!incoming.length && !gone.length) return;
    for (const e of incoming) known.set(e.id, key(e));
    for (const id of gone) known.delete(id);
    const next = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
    for (const id of gone) next.delete(id);
    // no binding repair on a partial set: it would unbind labels/arrows whose partners aren't in it
    for (const e of restoreElements(incoming as unknown as Els, null, { refreshDimensions: false, repairBindings: false })) next.set(e.id, e);
    const elements = [...next.values()].sort((x, y) => ((x.index ?? '') < (y.index ?? '') ? -1 : (x.index ?? '') > (y.index ?? '') ? 1 : 0));
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  };

  // full screen only (in a frame, the frame's bar has ✓ Done)
  const done = h('button', { className: 'xd-done', onClick: () => o.onDone(), title: 'Back to the canvas (⌘↵)' }, '← Back to canvas');
  const ip = o.inPlace;
  let cam = ip?.camera;
  const same = (a: Camera, b: Camera) => Math.abs(a.scrollX - b.scrollX) < 1e-6 && Math.abs(a.scrollY - b.scrollY) < 1e-6 && Math.abs(a.zoom - b.zoom) < 1e-9;
  const root = createRoot(host);
  root.render(
    h(Excalidraw, {
      initialData: {
        elements: restore(o.elements),
        appState: ip
          ? { viewBackgroundColor: '#ffffff', name: o.title, scrollX: ip.camera.scrollX, scrollY: ip.camera.scrollY, zoom: { value: ip.camera.zoom as never } }
          : { viewBackgroundColor: '#ffffff', name: o.title },
        scrollToContent: !ip,
      },
      // in a frame: Excalidraw's pans/zooms become the frame's view
      onScrollChange: ip
        ? (scrollX: number, scrollY: number, zoom: { value: number }) => {
            const c = { scrollX, scrollY, zoom: zoom.value };
            if (cam && same(c, cam)) return;
            cam = c;
            ip.onCamera(c);
          }
        : undefined,
      excalidrawAPI: (a: ExcalidrawImperativeAPI) => {
        api = a;
        if (queued) remote(queued);
        queued = null;
        if (o.tool && o.tool !== 'selection') setTimeout(() => api?.setActiveTool({ type: o.tool as never }), 0);
      },
      onChange: (els: readonly { id: string; version: number; versionNonce: number }[]) => onChange(els),
      renderTopRightUI: ip ? undefined : () => done,
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: true, export: { saveFileToDisk: true } } },
      autoFocus: true,
      viewModeEnabled: !!o.viewOnly,
    }),
  );
  return {
    remote,
    camera(c) {
      if (!api || (cam && same(c, cam))) return;
      cam = c;
      api.updateScene({ appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom as never } }, captureUpdate: CaptureUpdateAction.NEVER });
    },
    idle() {
      if (!api) return true;
      const s = api.getAppState();
      return !Object.keys(s.selectedElementIds).length && canLeave(s);
    },
    deselect() {
      const st = api?.getAppState();
      if (!api || !st || !canLeave(st) || !Object.keys(st.selectedElementIds).length) return false;
      api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
      return true;
    },
    tool() {
      return api?.getAppState().activeTool.type ?? 'selection';
    },
    close() {
      if (api) onChange(api.getSceneElementsIncludingDeleted());
      flush();
      root.unmount();
    },
  };
}
