import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { meta, decisions as registryDecisions, type Source as Src } from "../kit/registry.ts";
import { Badge, Source } from "../kit/layout.tsx";
import { fmtAsOf, fmtDate, plural, slug } from "../kit/util.ts";
import { shell } from "../kit/shell.ts";
import { useComments, useAnswerState, makeStore, Composer, FeedbackPanel, DecisionList, feedbackMarkdown, anchorFor, quoteAnchor, findAnchor, type Anchor, type Comment } from "./comments.tsx";
import { FeedbackCtx, decisionsMarkdown, reachable, type DecisionRow } from "../kit/feedback.ts";
import { usePresent } from "./present.ts";
import { Boundary } from "./Boundary.tsx";
import { allPages, groups, home, isMulti, pageById, pages } from "../kit/pages.ts";
import { hrefFor, parseHash, HOME } from "../kit/route.ts";
import { useRoute } from "../kit/router.tsx";
import { Status } from "../kit/layout.tsx";
import { PresentCtx } from "../kit/present.ts";

interface OutlineItem { id: string; title: string; level: number }

function useOutline(root: React.RefObject<HTMLElement | null>, pageId: string) {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [active, setActive] = useState("");
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const scan = () => {
      const next = [...el.querySelectorAll<HTMLElement>("[data-section]")].map((s) => ({ id: s.dataset.section!, title: s.dataset.title!, level: Number(s.dataset.level) }));
      setItems((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
    };
    scan();
    let t = 0;
    const mo = new MutationObserver(() => { clearTimeout(t); t = window.setTimeout(scan, 100); });
    mo.observe(el, { childList: true, subtree: true });
    return () => { mo.disconnect(); clearTimeout(t); };
  }, [root, pageId]);
  useEffect(() => {
    const onScroll = () => {
      let cur = "";
      for (const it of items) {
        const e = document.getElementById(it.id);
        if (e && e.getBoundingClientRect().top < innerHeight * 0.3) cur = it.id;
      }
      setActive(cur);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [items]);
  return { items, active };
}

const normSource = (s: string | Src): Src => (typeof s === "string" ? (/^https?:/.test(s) ? { label: s.replace(/^https?:\/\//, ""), href: s } : { label: s }) : s);
/** The page as the single HTML file it came in: re-fetch it, or rebuild it from its own style/script text (never the live DOM). */
async function pageSource(): Promise<string> {
  try {
    const r = await fetch(location.href, { cache: "no-store" });
    if (r.ok) { const t = await r.text(); if (t.includes('id="a-js"') && !t.includes("/__events")) return t; }
  } catch { /* file:// blocks fetch: use the inlined source */ }
  return shell(meta.title, document.getElementById("a-css")?.textContent ?? "", document.getElementById("a-js")?.textContent ?? "");
}
const canDownload = meta.host?.download ?? meta.download ?? true;
const SHORTCUTS: [string, string][] = [["p", "Present: ← → or space step, ↑ ↓ scroll, Esc leaves"], ["c", "Add a comment: opens the drawer, then click any element"], ["?", "This list"], ["Esc", "Close dialogs, leave comment mode"]];
const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");

function Sub({ items, active, page }: { items: OutlineItem[]; active: string; page: string }) {
  if (items.length < 2) return null; // a single section needs no sub-list
  return (
    <div className="h-sub">
      {items.map((it) => <a key={it.id} href={hrefFor(page, it.id)} className={it.id === active ? "on" : ""} style={{ paddingLeft: `${0.6 + (it.level - 1) * 0.7}rem` }}>{it.title}</a>)}
    </div>
  );
}

/** Previous / next page at the end of each page (nav order: home, then the groups). */
function PageNav({ current }: { current: string }) {
  const order = [home(), ...groups().flatMap((g) => g.pages)];
  const i = order.findIndex((p) => p.id === current);
  const prev = order[i - 1], next = order[i + 1];
  return (
    <nav className="h-pagenav" aria-label="Previous and next page">
      {prev ? <a href={hrefFor(prev.id)} className="prev"><span className="a-muted">← Previous</span><b>{prev.title}</b></a> : <span />}
      {next ? <a href={hrefFor(next.id)} className="next"><span className="a-muted">Next →</span><b>{next.title}</b></a> : <span />}
    </nav>
  );
}

/** Small dots at the corner of commented elements (blank-page artifacts have no section bar to show them). */
function Markers({ root, list, page, onOpen }: { root: React.RefObject<HTMLElement | null>; list: Comment[]; page: string; onOpen: () => void }) {
  const [dots, setDots] = useState<{ x: number; y: number; n: number }[]>([]);
  useEffect(() => {
    let raf = 0;
    const calc = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = root.current; if (!el) return;
        const m = new Map<HTMLElement, number>();
        for (const c of list) { if (c.anchor.page && c.anchor.page !== page) continue; const t = findAnchor(el, c.anchor.id); if (t) m.set(t, (m.get(t) ?? 0) + 1); }
        const out: { x: number; y: number; n: number }[] = [];
        for (const [t, n] of m) {
          const r = t.getBoundingClientRect();
          if ((!r.width && !r.height) || r.bottom < 0 || r.top > innerHeight) continue;
          out.push({ x: Math.round(Math.max(8, Math.min(r.right - 4, innerWidth - 14))), y: Math.round(Math.max(4, Math.min(r.top - 4, innerHeight - 14))), n });
        }
        setDots((p) => (JSON.stringify(p) === JSON.stringify(out) ? p : out));
      });
    };
    calc();
    const mo = new MutationObserver(calc); if (root.current) mo.observe(root.current, { childList: true, subtree: true, attributes: true });
    addEventListener("scroll", calc, { capture: true, passive: true }); addEventListener("resize", calc);
    const t = setInterval(calc, 700);
    return () => { cancelAnimationFrame(raf); mo.disconnect(); removeEventListener("scroll", calc, true); removeEventListener("resize", calc); clearInterval(t); };
  }, [root, list, page]);
  return <>{dots.map((d, i) => <button key={i} className="h-dot" style={{ left: d.x, top: d.y }} onClick={onOpen} aria-label={`${d.n} comment${d.n > 1 ? "s" : ""} here`} title={`${d.n} comment${d.n > 1 ? "s" : ""}`} />)}</>;
}

const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); };

export function Host() {
  const content = useRef<HTMLElement>(null);
  const bare = meta.shell === "bare"; // the artifact owns the layout: the host adds only the feedback layer and a corner menu
  const route = useRoute();
  const route_ = { page: route.page, section: route.anchor };
  const page = pageById(route.page) ?? home();
  const { items, active } = useOutline(content, page.id);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "midnight");
  const [mode, setMode] = useState(false);          // comment mode
  const [open, setOpen] = useState<Anchor | null>(null);
  const [panel, setPanel] = useState(false);
  const [help, setHelp] = useState(false);
  const [outlineOff, setOutlineOff] = useState(localStorage.getItem("artifact-outline") === "off");
  const [allSources, setAllSources] = useState(false);
  const [copied, setCopied] = useState("");
  const [more, setMore] = useState(false);
  const store = useMemo(() => makeStore(`${meta.title}|${meta.created ?? ""}`), []);
  const cm = useComments(store);
  const am = useAnswerState(store);
  const [rawRows, setRawRows] = useState<Omit<DecisionRow, "answer">[]>([]);
  // every page's decisions (found at build time, those behind a <When> only once reachable) plus what this page shows now
  const rows: DecisionRow[] = useMemo(() => {
    const out = new Map<string, DecisionRow>();
    const order = allPages().map((p) => p.id);
    for (const d of registryDecisions) if (reachable(d, am.answers)) out.set(d.id, { id: d.id, question: d.question, recommended: d.recommended, owner: d.owner, page: d.page, pageTitle: pageById(d.page)?.title });
    for (const r of rawRows) if (!out.has(r.id)) out.set(r.id, { ...r, page: isMulti() ? page.id : undefined, pageTitle: isMulti() ? page.title : undefined });
    const list = [...out.values()];
    if (isMulti()) list.sort((a, b) => order.indexOf(a.page ?? HOME) - order.indexOf(b.page ?? HOME));
    return list.map((r) => ({ ...r, answer: am.answers[r.id] }));
  }, [rawRows, am.answers, page.id]);
  const [tab, setTab] = useState<"decisions" | "comments">("decisions");
  const summary = useRef<HTMLElement>(null);
  const lastPage = useRef(route.page);
  const [menu, setMenu] = useState(false);
  const [sel, setSel] = useState<{ a: Anchor; x: number; y: number } | null>(null);
  useEffect(() => {
    // a page change: a tour continues (or starts) on the new page; presenting anything else ends at the page change
    const pend = tourRef.current.pending;
    if (!pend && !present.active) return;
    const t = setTimeout(() => {
      if (present.active) present.stop();
      if (tourRef.current.on && pend) { tourRef.current.pending = null; present.start(pend === "last" ? 9999 : 0); }
      else tourRef.current.on = false;
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);
  const head = useRef<HTMLElement>(null);
  // tour: artifact.json "tour": ["home", "a", "b"] presents across pages in order
  const tourIds = useMemo(() => (meta.tour ?? []).filter((id) => !!pageById(id)), []);
  const hasTour = tourIds.length > 1;
  const tourRef = useRef<{ on: boolean; pending: "first" | "last" | null }>({ on: false, pending: null });
  const goTour = (dir: 1 | -1) => {
    const i = tourIds.indexOf(page.id);
    const nextId = tourIds[i + dir];
    if (i < 0 || !nextId) { if (dir === 1) { tourRef.current.on = false; present.stop(); } return; } // past the end: leave
    tourRef.current.pending = dir === 1 ? "first" : "last";
    location.hash = hrefFor(nextId);
  };
  const present = usePresent(content, head, page.title, summary, (dir) => { if (tourRef.current.on) goTour(dir); });

  useEffect(() => { document.title = page.id === HOME ? meta.title : `${page.title} · ${meta.title}`; }, [page]);
  useEffect(() => {
    // after a route change: open and scroll to the section, or go to the top of the new page
    const t = setTimeout(() => {
      const el = route_.section ? document.getElementById(route_.section) : null;
      if (el) { for (let e: Element | null = el; e; e = e.parentElement) { if (e.matches?.(".a-section")) e.removeAttribute("data-folded"); if (e.tagName === "DETAILS") (e as HTMLDetailsElement).open = true; } el.scrollIntoView({ block: "start" }); }
      else if (route.page !== lastPage.current) scrollTo({ top: 0, behavior: "instant" });
      lastPage.current = route.page;
      doJump();
    }, 30);
    return () => clearTimeout(t);
  }, [route.page, route.anchor]);
  useEffect(() => {
    const el = content.current!;
    const scan = () => {
      const next = [...el.querySelectorAll<HTMLElement>('[data-c="decision"]')].map((d) => ({ id: d.dataset.did ?? d.id, question: d.dataset.q ?? "", recommended: d.dataset.rec || undefined, owner: d.dataset.owner }));
      setRawRows((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [page.id]);
  const setTheme = (d: boolean) => {
    setDark(d); localStorage.setItem("artifact-theme", d ? "dark" : "light");
    if (d) document.documentElement.dataset.theme = "midnight"; else delete document.documentElement.dataset.theme;
  };

  useEffect(() => {
    if (!present.active) { setMore(false); return; }
    const f = () => setMore(document.documentElement.scrollHeight - (scrollY + innerHeight) > 40);
    f();
    const t = setInterval(f, 400);
    addEventListener("scroll", f, { passive: true }); addEventListener("resize", f);
    return () => { clearInterval(t); removeEventListener("scroll", f); removeEventListener("resize", f); };
  }, [present.active]);

  // keys: c comment mode, p present, ? shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (present.active) return;
      if (e.key === "c") setMode((m) => { if (!m) { setPanel(true); setTab("comments"); } return !m; });
      else if (e.key === "p") { tourRef.current.on = false; present.start(); }
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") { setMode(false); setOpen(null); setHelp(false); setMenu(false); setSel(null); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [present.active, present.start]);

  // comment mode: hover outline + click to comment
  const hover = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!mode) return;
    const el = content.current!;
    const over = (e: MouseEvent) => {
      const a = anchorFor(e.target as HTMLElement, el, bare);
      if (hover.current !== a?.el) { hover.current?.removeAttribute("data-hover"); hover.current = a?.el ?? null; a?.el.setAttribute("data-hover", ""); }
    };
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, button")) { e.preventDefault(); }
      const a = anchorFor(t, el, bare);
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      setOpen(a);
    };
    el.addEventListener("mouseover", over);
    el.addEventListener("click", click, true);
    document.documentElement.dataset.commenting = "";
    return () => {
      el.removeEventListener("mouseover", over); el.removeEventListener("click", click, true);
      hover.current?.removeAttribute("data-hover"); hover.current = null;
      delete document.documentElement.dataset.commenting;
    };
  }, [mode, bare]);
  // alt-click comments on any element without comment mode; selecting text offers a small "Comment" button (blank-page artifacts)
  useEffect(() => {
    const el = content.current!;
    const alt = (e: MouseEvent) => {
      if (!e.altKey || mode || present.active) return;
      const a = anchorFor(e.target as HTMLElement, el, bare);
      if (!a) return;
      e.preventDefault(); e.stopPropagation(); setOpen(a);
    };
    const up = () => setTimeout(() => {
      const s = getSelection();
      const a = bare && s && !s.isCollapsed && !mode && !present.active ? quoteAnchor(s, el, true) : null;
      if (!a || !s) { setSel(null); return; }
      const r = s.getRangeAt(0).getBoundingClientRect();
      setSel({ a, x: Math.min(r.right, innerWidth - 90), y: Math.min(r.bottom + 6, innerHeight - 40) });
    }, 0);
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".h-selbtn")) setSel(null); };
    el.addEventListener("click", alt, true); el.addEventListener("mouseup", up); document.addEventListener("mousedown", down);
    return () => { el.removeEventListener("click", alt, true); el.removeEventListener("mouseup", up); document.removeEventListener("mousedown", down); };
  }, [mode, bare, present.active]);
  useEffect(() => {
    if (!menu) return;
    const f = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".h-corner")) setMenu(false); };
    document.addEventListener("pointerdown", f);
    return () => document.removeEventListener("pointerdown", f);
  }, [menu]);
  // mark commented elements
  useEffect(() => {
    const el = content.current!;
    const mark = () => {
      el.querySelectorAll("[data-commented]").forEach((n) => n.removeAttribute("data-commented"));
      for (const c of cm.list) { if (c.anchor.page && c.anchor.page !== page.id) continue; findAnchor(el, c.anchor.id)?.setAttribute("data-commented", ""); }
    };
    mark();
    const mo = new MutationObserver(() => { mo.disconnect(); mark(); mo.observe(el, { childList: true, subtree: true }); });
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [cm.list]);

  useEffect(() => {
    // a link to something collapsed opens it (and what contains it)
    const open = () => {
      const r = parseHash(location.hash);
      const id = r ? r.section ?? "" : decodeURIComponent(location.hash.slice(1));
      const t = id ? document.getElementById(id) : null;
      for (let e = t; e; e = e.parentElement) { if (e.matches?.(".a-section")) e.removeAttribute("data-folded"); if (e.matches?.(".a-heavy")) e.setAttribute("data-open", ""); if (e.tagName === "DETAILS") (e as HTMLDetailsElement).open = true; }
    };
    addEventListener("hashchange", open);
    document.addEventListener("click", (e) => { const h = (e.target as HTMLElement).closest?.('a[href^="#"]')?.getAttribute("href"); if (h && h.length > 1) setTimeout(open, 0); });
    return () => removeEventListener("hashchange", open);
  }, []);

  /** Fold or unfold every Section (the "?" panel). */
  const foldAll = (fold: boolean) => document.querySelectorAll(".a-section").forEach((s) => s.toggleAttribute("data-folded", fold));

  const download = useCallback(async () => {
    const blob = new Blob([await pageSource()], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${slug(meta.title) || "artifact"}.html`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }, []);

  const copyText = useCallback(async (md: string, flag: string) => {
    try { await navigator.clipboard.writeText(md); } catch {
      const ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setCopied(flag); setTimeout(() => setCopied(""), 1600);
  }, []);
  const decisionsMd = () => decisionsMarkdown(meta.title, rows);
  const allMd = () => `${decisionsMd()}\n${cm.list.length ? feedbackMarkdown(meta.title, cm.list) : ""}`.trimEnd() + "\n";
  const jumpTo = useRef<{ did?: string; anchor?: string } | null>(null);
  const doJump = () => {
    const j = jumpTo.current; if (!j) return;
    const root = content.current;
    const el = j.did ? root?.querySelector<HTMLElement>(`[data-did="${CSS.escape(j.did)}"]`) : j.anchor && root ? findAnchor(root, j.anchor) : null;
    if (!el) return;
    jumpTo.current = null;
    if (present.active) present.goTo(el); else el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  /** Jump to a decision or comment, going to its page first when it lives on another one. */
  const jump = (target: { did?: string; anchor?: string }, onPage?: string) => {
    jumpTo.current = target;
    if (onPage && onPage !== page.id) { location.hash = hrefFor(onPage); } else doJump();
  };
  const jumpDecision = (r: DecisionRow) => jump({ did: r.id }, r.page);
  const jumpComment = (c: { anchor: { id: string; page?: string } }) => jump({ anchor: c.anchor.id }, c.anchor.page);

  const sources = (meta.sources ?? []).map(normSource);
  const decided = rows.filter((r) => r.answer).length;
  const feedbackLabel = ["Feedback", rows.length ? `${decided}/${rows.length} decided` : "", cm.list.length ? plural(cm.list.length, "note") : ""].filter(Boolean).join(" · ").replace("Feedback ·", "Feedback:");
  const compact = meta.header !== "full";
  return (
    <div className="h-root" data-shell={bare ? "bare" : undefined}>
      {!bare && <div className="h-bar" role="toolbar" aria-label="Page tools">
        <span className="h-bar-title">{meta.title}</span>
        {isMulti() && (
          <select className="h-pagesel" aria-label="Go to page" value={page.id} onChange={(e) => { location.hash = hrefFor(e.target.value); }}>
            {allPages().map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <span className="h-spacer" />
        <button className="h-btn" onClick={() => setPanel(!panel)} aria-pressed={panel} title="Feedback: answer the decisions and leave comments, then copy it all back to the author">{feedbackLabel}</button>
        <button className="h-btn" onClick={() => { tourRef.current.on = false; present.start(); }} title="Present (p): walk through this page full screen">Present</button>
        {hasTour && <button className="h-btn" onClick={() => { tourRef.current.on = true; if (page.id === tourIds[0]) present.start(); else { tourRef.current.pending = "first"; location.hash = hrefFor(tourIds[0]); } }} title="Tour: present the pages in the author's order">Tour</button>}
        <button className="h-btn" aria-pressed={!outlineOff} onClick={() => { setOutlineOff(!outlineOff); localStorage.setItem("artifact-outline", outlineOff ? "on" : "off"); }} title="Show or hide the outline on the left">Outline</button>
        <button className="h-btn" onClick={() => setTheme(!dark)} title="Switch between the light and dark theme">{dark ? "Light" : "Dark"}</button>
        {canDownload && <button className="h-btn" onClick={download} title="Save this page as one self-contained HTML file">Download</button>}
        <button className="h-btn h-help" aria-pressed={help} onClick={() => setHelp(!help)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
        {help && (
          <div className="h-pop" role="dialog" aria-label="Keyboard shortcuts">
            <b>Shortcuts</b>
            {SHORTCUTS.map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
            <div className="h-pop-actions">
              <button className="h-btn" onClick={() => foldAll(true)} title="Fold every section to its heading">Fold all</button>
              <button className="h-btn" onClick={() => foldAll(false)}>Unfold all</button>
            </div>
          </div>
        )}
      </div>}
      <div className="h-layout" data-outline={outlineOff ? "off" : undefined}>
        {!bare && <nav className="h-outline" aria-label={isMulti() ? "Pages" : "Outline"}>
          {isMulti() && (
            <div className="h-pages">
              <a href={hrefFor(HOME)} className={cx("h-page", page.id === HOME && "on")}>{home().title}</a>
              {page.id === HOME && <Sub items={items} active={active} page={page.id} />}
              {groups().map((g) => (
                <div key={g.name || "_"} className="h-group-nav">
                  {g.name && <div className="h-group-name">{g.name}</div>}
                  {g.pages.map((p) => (
                    <div key={p.id}>
                      <a href={hrefFor(p.id)} className={cx("h-page", p.id === page.id && "on")}>{p.icon && <span aria-hidden>{p.icon} </span>}{p.title}</a>
                      {p.id === page.id && <Sub items={items} active={active} page={page.id} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!isMulti() && items.map((it) => (
            <a key={it.id} href={`#${it.id}`} className={it.id === active ? "on" : ""} style={{ paddingLeft: `${0.6 + (it.level - 1) * 0.8}rem` }}>{it.title}</a>
          ))}
        </nav>}
        <main className="h-main" data-width={meta.width}>
          {!bare && <header className="h-head" data-header={compact ? "compact" : "full"} ref={head}>
            {page.id !== HOME && (
              <div className="h-crumbs"><a href={hrefFor(HOME)}>{meta.title}</a>{page.group && <> › <span>{page.group}</span></>}</div>
            )}
            <div className="h-meta">
              {page.id === HOME && meta.kind && <Badge tone="accent">{meta.kind}</Badge>}
              {page.id !== HOME && page.status && <Status s={page.status as never} />}
              {page.id === HOME && meta.audience && <span title="audience"><span className="a-muted">Audience:</span> {meta.audience}</span>}
              {meta.asOf ? <span title="gathered at">as of {fmtAsOf(meta.asOf, meta.timeZone)}</span> : meta.created && <span>{fmtDate(meta.created)}</span>}
            </div>
            <h1>{page.title}</h1>
            {page.summary && <p className="h-summary">{page.summary}</p>}
            {page.id === HOME && sources.length > 0 && (compact ? (
              <div className="h-sources">
                <button className="h-more" aria-expanded={allSources} onClick={() => setAllSources(!allSources)}>Sources ({sources.length}) {allSources ? "▾" : "▸"}</button>
                {allSources && sources.map((s, i) => <Source key={i} {...s} />)}
              </div>
            ) : (
              <div className="h-sources"><span className="a-muted">Sources</span>
                {(allSources ? sources : sources.slice(0, 3)).map((s, i) => <Source key={i} {...s} />)}
                {sources.length > 3 && <button className="h-more" onClick={() => setAllSources(!allSources)}>{allSources ? "show fewer" : `+${sources.length - 3} sources`}</button>}
              </div>
            ))}
          </header>}
          <FeedbackCtx.Provider value={{ interactive: true, answers: am.answers, answer: am.answer }}>
            <PresentCtx.Provider value={present.state}><article className="a-content" ref={content} data-page={page.id}><Boundary key={page.id}><page.Component /></Boundary></article></PresentCtx.Provider>
          </FeedbackCtx.Provider>
          {isMulti() && !bare && <PageNav current={page.id} />}
          {rows.length > 0 && (!tourRef.current.on || page.id === tourIds[tourIds.length - 1]) && (
            <section className="h-summary-slide" ref={summary} data-title="Summary">
              <h2 className="a-h">Summary: {decided}/{rows.length} decided</h2>
              <DecisionList rows={rows} onJump={jumpDecision} />
              <div className="h-panel-actions">
                <button className="h-btn" disabled={!decided} onClick={() => copyText(decisionsMd(), "decisions")}>{copied === "decisions" ? "Copied" : "Copy decisions"}</button>
                <button className="h-btn" disabled={!decided && !cm.list.length} onClick={() => copyText(allMd(), "all")}>{copied === "all" ? "Copied" : "Copy all feedback"}</button>
              </div>
            </section>
          )}
        </main>
        {panel && <FeedbackPanel cm={cm} rows={rows} tab={rows.length ? tab : "comments"} setTab={setTab} mode={mode} onMode={() => setMode(!mode)} copied={copied}
          onCopyComments={() => copyText(feedbackMarkdown(meta.title, cm.list), "comments")} onCopyDecisions={() => copyText(decisionsMd(), "decisions")} onCopyAll={() => copyText(allMd(), "all")}
          onClearAnswers={am.clear} onJumpDecision={jumpDecision} onJumpComment={jumpComment} pageTitle={(id) => (id ? pageById(id)?.title : undefined)} onClose={() => { setPanel(false); setMode(false); }} />}
      </div>
      {bare && !present.active && (
        <>
          <Markers root={content} list={cm.list} page={page.id} onOpen={() => { setPanel(true); setTab("comments"); }} />
          <div className="h-corner" data-open={menu ? "" : undefined}>
            {menu && (
              <div className="h-corner-menu" role="menu" aria-label="Page menu">
                <button role="menuitem" onClick={() => { setPanel(!panel); setMenu(false); }}>{feedbackLabel}</button>
                <button role="menuitem" onClick={() => { setMenu(false); tourRef.current.on = false; present.start(); }}>Present <kbd>p</kbd></button>
                {hasTour && <button role="menuitem" onClick={() => { setMenu(false); tourRef.current.on = true; if (page.id === tourIds[0]) present.start(); else { tourRef.current.pending = "first"; location.hash = hrefFor(tourIds[0]); } }}>Tour</button>}
                {canDownload && <button role="menuitem" onClick={() => { setMenu(false); download(); }}>Download</button>}
                <button role="menuitem" onClick={() => { setMenu(false); setTheme(!dark); }}>{dark ? "Light theme" : "Dark theme"}</button>
                <button role="menuitem" onClick={() => { setMenu(false); setHelp(true); }}>Shortcuts <kbd>?</kbd></button>
              </div>
            )}
            {help && (
              <div className="h-pop h-pop-corner" role="dialog" aria-label="Keyboard shortcuts">
                <b>Shortcuts</b>
                {SHORTCUTS.map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
                <div><kbd>⌥ click</kbd><span>Comment on the element; or select text and press Comment</span></div>
              </div>
            )}
            <button className="h-corner-btn" aria-label="Page menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><circle cx="2.5" cy="7" r="1.3" fill="currentColor" /><circle cx="7" cy="7" r="1.3" fill="currentColor" /><circle cx="11.5" cy="7" r="1.3" fill="currentColor" /></svg>
            </button>
          </div>
          {sel && <button className="h-selbtn" style={{ left: sel.x, top: sel.y }} onClick={() => { setOpen(sel.a); setSel(null); getSelection()?.removeAllRanges(); }}>Comment</button>}
        </>
      )}
      {open && <Composer anchor={open} onCancel={() => setOpen(null)} onSave={(body) => { cm.add(open, body, isMulti() ? page.id : undefined); setOpen(null); }} existing={cm.list.filter((c) => c.anchor.id === open.id && (!c.anchor.page || c.anchor.page === page.id))} />}
      {present.active && (
        <div className="h-present-bar" data-slide={present.state.slide} data-slides={present.state.slides} data-step={present.state.step} data-steps={present.state.steps}>
          <button onClick={present.prev}>←</button>
          <span className="h-present-label">{tourRef.current.on ? `${tourIds.indexOf(page.id) + 1}/${tourIds.length} ${page.title} · ` : ""}{present.label}</span>
          {more && <span className="h-more-hint h-present-hint" title="This slide continues below: scroll or press ↓">↓ more</span>}
          <button onClick={present.next}>→</button>
          <button onClick={present.stop}>Exit</button>
        </div>
      )}
    </div>
  );
}
