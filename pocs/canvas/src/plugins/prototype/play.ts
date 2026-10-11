import type { App } from '../../core';
import { pageFrame, readMessage } from './bridge';
import { History } from './history';
import { docHeight, isNote, isPage, note, outgoing, page, resolveLink, titleOf } from './model';

// Play: the flow full screen, like a Figma prototype. Links in the page follow the canvas edges;
// Back, a breadcrumb of the path, and the page's outgoing links as chips (works for pages without
// any link markup). Form values live in a per-session state the pages can read.
//
// Multiplayer: the presenter's page, path and state go out in awareness (`play` field, ephemeral);
// others get a "Follow" banner and, when following, mirror the presenter until they click themselves.

interface PlayState {
  page: string;
  path: string[];
  state: Record<string, string>;
}
type Awareness = { clientID: number; getStates(): Map<number, any>; setLocalStateField(k: string, v: unknown): void; on(e: string, f: () => void): void };
const aw = (app: App) => app.presence?.awareness as unknown as Awareness | undefined;

export class Player {
  private root: HTMLElement | null = null;
  private hist: History | null = null;
  private state: Record<string, string> = {};
  private frame: HTMLIFrameElement | null = null;
  /** Following another player's Play (their awareness client id). */
  following: number | null = null;
  private lastMirror = '';
  private notesOn = true;
  private onKey = (e: KeyboardEvent) => this.key(e);
  private onResize = () => this.layout();
  private offStore: (() => void) | null = null;

  constructor(private app: App) {
    window.addEventListener('message', (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const m = readMessage(e.data);
      if (!m) return;
      if (m.kind === 'set') {
        this.state[m.key] = m.value;
        this.broadcast();
      } else if (m.kind === 'back') this.back();
      else if (m.kind === 'escape') this.close();
      else this.follow(m.target);
    });
  }

  get isOpen() {
    return !!this.root;
  }
  get current() {
    return this.hist?.current;
  }

  start(pageId: string, opts: { follow?: number } = {}) {
    if (!isPage(this.app.node(pageId))) return;
    this.hist = new History(pageId);
    this.state = {};
    this.following = opts.follow ?? null;
    this.lastMirror = '';
    if (!this.root) this.mount();
    this.show();
  }

  close() {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    this.frame = null;
    this.hist = null;
    this.following = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    this.offStore?.();
    aw(this.app)?.setLocalStateField('play', null);
    this.app.view.root.focus({ preventScroll: true });
  }

  /** Follow a link from the current page (a `data-goto` target or an edge's label). */
  follow(target: string) {
    const h = this.hist;
    if (!h) return;
    const r = resolveLink(this.app.doc, h.current, target);
    if (!r) {
      this.toast(target ? `No link “${target}” from ${titleOf(this.app.node(h.current))}` : `${titleOf(this.app.node(h.current))} has no single next page`);
      return;
    }
    this.byMe();
    h.go(r.to);
    this.show();
  }

  back() {
    if (!this.hist?.back()) return;
    this.byMe();
    this.show();
  }

  private byMe() {
    if (this.following === null) return;
    this.following = null;
    this.toast('Stopped following');
  }

  private mount() {
    const r = document.createElement('div');
    r.className = 'pg-play';
    r.innerHTML = `<header>
        <button class="pg-back" title="Back (←)">‹ Back</button>
        <nav class="pg-crumbs"></nav>
        <span class="pg-follow"></span>
        <button class="pg-notes-btn" title="Show notes (N)">Notes</button>
        <button class="pg-restart" title="Restart (R)">↺ Restart</button>
        <button class="pg-exit" title="Exit (Esc)">✕</button>
      </header>
      <div class="pg-stage"><div class="pg-device"></div><aside class="pg-notes"></aside></div>
      <footer><span class="pg-links-title">Links</span><span class="pg-links"></span></footer>
      <div class="pg-toast"></div>`;
    r.querySelector('.pg-back')!.addEventListener('click', () => this.back());
    r.querySelector('.pg-restart')!.addEventListener('click', () => {
      this.byMe();
      this.hist?.restart();
      this.state = {};
      this.show();
    });
    r.querySelector('.pg-exit')!.addEventListener('click', () => this.close());
    r.querySelector('.pg-notes-btn')!.addEventListener('click', () => {
      this.notesOn = !this.notesOn;
      this.show(false);
    });
    document.body.append(r);
    this.root = r;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    // pages edited or deleted while playing (by anyone): show the new version
    let last = '';
    this.offStore = this.app.store.subscribe(() => {
      const h = this.hist;
      if (!h) return;
      h.prune((id) => isPage(this.app.node(id)));
      if (!h.path.length) return this.close();
      const n = this.app.node(h.current)!;
      const k = page(n).html + page(n).vw;
      if (k !== last) {
        last = k;
        this.show(true);
      } else this.show(false);
    });
  }

  private key(e: KeyboardEvent) {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') this.back();
    else if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) this.root?.querySelector<HTMLButtonElement>('.pg-restart')!.click();
    else if (e.key.toLowerCase() === 'n') this.root?.querySelector<HTMLButtonElement>('.pg-notes-btn')!.click();
    else return;
    e.preventDefault();
  }

  /** Render the current page (reload = new frame), breadcrumb, links, notes. */
  private show(reload = true) {
    const r = this.root;
    const h = this.hist;
    if (!r || !h) return;
    const doc = this.app.doc;
    const n = doc.get(h.current);
    if (!isPage(n)) return;
    if (reload || !this.frame) {
      const f = page(n);
      this.frame = pageFrame(f.html, f.vw, docHeight(n), 1, this.state);
      this.frame.style.pointerEvents = 'auto';
      r.querySelector('.pg-device')!.replaceChildren(this.frame);
      this.layout();
      // focus the page once it has loaded (before that, keys stay with Play: Esc, ←)
      const frame = this.frame;
      (document.activeElement as HTMLElement | null)?.blur?.();
      frame.addEventListener('load', () => frame.isConnected && frame.focus(), { once: true });
    }
    // breadcrumb
    const crumbs = r.querySelector('.pg-crumbs')!;
    crumbs.replaceChildren();
    h.path.forEach((id, i) => {
      if (i) crumbs.append(Object.assign(document.createElement('span'), { className: 'pg-sep', textContent: '›' }));
      const b = document.createElement('button');
      b.textContent = titleOf(doc.get(id));
      b.className = i === h.path.length - 1 ? 'pg-crumb pg-here' : 'pg-crumb';
      b.addEventListener('click', () => {
        this.byMe();
        h.jump(i);
        this.show();
      });
      crumbs.append(b);
    });
    (r.querySelector('.pg-back') as HTMLButtonElement).disabled = h.path.length < 2;
    // outgoing links as chips
    const links = r.querySelector('.pg-links')!;
    links.replaceChildren();
    for (const e of outgoing(doc, n.id)) {
      const b = document.createElement('button');
      b.className = 'pg-chip';
      b.textContent = `${e.label ?? '→'}  →  ${titleOf(doc.get(e.toNode))}`;
      b.addEventListener('click', () => {
        this.byMe();
        h.go(e.toNode);
        this.show();
      });
      links.append(b);
    }
    if (!links.childElementCount) links.textContent = 'No links from this page (an end of the flow)';
    // the page's sticky notes beside the device
    const notes = r.querySelector<HTMLElement>('.pg-notes')!;
    const mine = doc.nodes.filter((x) => isNote(x) && note(x).on === n.id);
    notes.replaceChildren(...mine.map((x) => Object.assign(document.createElement('div'), { className: 'pg-note-card', textContent: x.text ?? '' })));
    notes.hidden = !this.notesOn || !mine.length;
    r.querySelector('.pg-notes-btn')!.classList.toggle('pg-on', this.notesOn);
    r.querySelector('.pg-notes-btn')!.textContent = `Notes${mine.length ? ` (${mine.length})` : ''}`;
    // follow status
    const fs = r.querySelector('.pg-follow')!;
    const who = this.following !== null ? aw(this.app)?.getStates().get(this.following)?.user : undefined;
    fs.replaceChildren();
    if (who) {
      fs.innerHTML = `<span class="pg-dot"></span>Following <b></b> <button>Stop</button>`;
      fs.querySelector('b')!.textContent = who.name;
      (fs.querySelector('.pg-dot') as HTMLElement).style.background = who.color;
      fs.querySelector('button')!.addEventListener('click', () => this.byMe());
    }
    this.broadcast();
  }

  private layout() {
    const r = this.root;
    const n = this.hist ? this.app.node(this.hist.current) : undefined;
    if (!r || !this.frame || !isPage(n)) return;
    const stage = r.querySelector<HTMLElement>('.pg-stage')!;
    const vw = page(n).vw;
    const vh = docHeight(n);
    const s = Math.min(1, (stage.clientWidth - 48) / vw, (stage.clientHeight - 32) / vh);
    this.frame.style.transform = `scale(${s})`;
    const dev = r.querySelector<HTMLElement>('.pg-device')!;
    dev.style.width = `${vw * s}px`;
    dev.style.height = `${vh * s}px`;
  }

  private toast(msg: string) {
    const t = this.root?.querySelector<HTMLElement>('.pg-toast');
    if (!t) return this.app.notify(msg);
    t.textContent = msg;
    t.classList.add('pg-show');
    clearTimeout((t as any)._t);
    (t as any)._t = setTimeout(() => t.classList.remove('pg-show'), 2200);
  }

  /** Tell the room where I am in Play (only when presenting, not when following). */
  private broadcast() {
    const a = aw(this.app);
    if (!a || !this.hist) return;
    const p: PlayState | null = this.following === null ? { page: this.hist.current, path: this.hist.path, state: this.state } : null;
    a.setLocalStateField('play', p);
  }

  /** Following: go where the presenter is (called on awareness changes once in a room). */
  mirror() {
    const a = aw(this.app);
    if (!a || this.following === null || !this.hist) return;
    const p = a.getStates().get(this.following)?.play as PlayState | null | undefined;
    if (!p) {
      this.toast('The presenter stopped');
      this.following = null;
      this.show(false);
      return;
    }
    const key = JSON.stringify(p);
    if (key === this.lastMirror) return; // cursor moves etc.
    this.lastMirror = key;
    const path = p.path.filter((id) => isPage(this.app.node(id)));
    if (!path.length) return;
    const moved = this.hist.current !== path[path.length - 1] || JSON.stringify(this.state) !== JSON.stringify(p.state);
    this.hist.path = path;
    this.state = { ...p.state };
    this.show(moved);
  }
}

/** Others presenting: a banner with Follow buttons (bottom of the table). */
export function mountFollowBanner(app: App, player: Player) {
  const a = aw(app);
  if (!a) return;
  const el = document.createElement('div');
  el.className = 'pg-banner';
  // outside the table: the table captures the pointer on press (a click inside it never lands)
  document.body.append(el);
  const draw = () => {
    const presenters = [...a.getStates()].filter(([id, s]) => id !== a.clientID && s?.play && s.user);
    el.replaceChildren();
    el.hidden = !presenters.length || (player.isOpen && player.following !== null);
    for (const [id, s] of presenters) {
      const row = document.createElement('div');
      row.innerHTML = `<span class="pg-dot"></span><b></b> is presenting <i></i> <button>Follow</button>`;
      (row.querySelector('.pg-dot') as HTMLElement).style.background = s.user.color;
      row.querySelector('b')!.textContent = s.user.name;
      row.querySelector('i')!.textContent = titleOf(app.node(s.play.page));
      row.querySelector('button')!.addEventListener('click', () => {
        player.start(s.play.page, { follow: id });
        // take their path and state right away
        player.mirror();
      });
      el.append(row);
    }
  };
  a.on('change', () => {
    player.mirror();
    draw();
  });
  draw();
}
