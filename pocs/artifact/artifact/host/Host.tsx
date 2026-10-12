import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { meta, type Source as Src } from "../kit/registry.ts";
import { Badge, Source } from "../kit/layout.tsx";
import { fmtAsOf, fmtDate, plural, slug } from "../kit/util.ts";
import { shell } from "../kit/shell.ts";
import { useComments, useAnswerState, makeStore, Composer, FeedbackPanel, DecisionList, feedbackMarkdown, anchorFor, findAnchor, type Anchor } from "./comments.tsx";
import { FeedbackCtx, decisionsMarkdown, type DecisionRow } from "../kit/feedback.ts";
import { usePresent } from "./present.ts";
import { Boundary } from "./Boundary.tsx";
import { allPages, groups, home, isMulti, pageById, pages } from "../kit/pages.ts";
import { hrefFor, parseHash, HOME, type Route } from "../kit/route.ts";
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

const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); };

export function Host() {
  const content = useRef<HTMLElement>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash) ?? { page: HOME });
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
  const rows: DecisionRow[] = useMemo(() => rawRows.map((r) => ({ ...r, answer: am.answers[r.id] })), [rawRows, am.answers]);
  const [tab, setTab] = useState<"decisions" | "comments">("decisions");
  const summary = useRef<HTMLElement>(null);
  const lastPage = useRef(route.page);
  const head = useRef<HTMLElement>(null);
  const present = usePresent(content, head, meta.title, summary);

  useEffect(() => { document.title = page.id === HOME ? meta.title : `${page.title} · ${meta.title}`; }, [page]);
  // hash routes: #/page and #/page/section; a plain #anchor stays an in-page anchor and never changes the page
  useEffect(() => {
    const f = () => { const r = parseHash(location.hash); if (r) setRoute(r); else if (location.hash === "" || location.hash === "#") setRoute({ page: HOME }); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    // after a route change: open and scroll to the section, or go to the top of the new page
    const t = setTimeout(() => {
      const el = route.section ? document.getElementById(route.section) : null;
      if (el) { for (let e: Element | null = el; e; e = e.parentElement) { if (e.matches?.(".a-section")) e.removeAttribute("data-folded"); if (e.tagName === "DETAILS") (e as HTMLDetailsElement).open = true; } el.scrollIntoView({ block: "start" }); }
      else if (route.page !== lastPage.current) scrollTo({ top: 0 });
      lastPage.current = route.page;
    }, 30);
    return () => clearTimeout(t);
  }, [route]);
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
      else if (e.key === "p") present.start();
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") { setMode(false); setOpen(null); setHelp(false); }
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
      const a = anchorFor(e.target as HTMLElement, el);
      if (hover.current !== a?.el) { hover.current?.removeAttribute("data-hover"); hover.current = a?.el ?? null; a?.el.setAttribute("data-hover", ""); }
    };
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, button")) { e.preventDefault(); }
      const a = anchorFor(t, el);
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
  }, [mode]);
  // mark commented elements
  useEffect(() => {
    const el = content.current!;
    const mark = () => {
      el.querySelectorAll("[data-commented]").forEach((n) => n.removeAttribute("data-commented"));
      for (const c of cm.list) { findAnchor(el, c.anchor.id)?.setAttribute("data-commented", ""); }
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
  const jumpDecision = (id: string) => {
    const el = content.current?.querySelector<HTMLElement>(`[data-did="${CSS.escape(id)}"]`);
    if (!el) return;
    if (present.active) present.goTo(el); else el.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const sources = (meta.sources ?? []).map(normSource);
  const decided = rows.filter((r) => r.answer).length;
  const feedbackLabel = ["Feedback", rows.length ? `${decided}/${rows.length} decided` : "", cm.list.length ? plural(cm.list.length, "note") : ""].filter(Boolean).join(" · ").replace("Feedback ·", "Feedback:");
  const compact = meta.header !== "full";
  return (
    <div className="h-root">
      <div className="h-bar" role="toolbar" aria-label="Page tools">
        <span className="h-bar-title">{meta.title}</span>
        {isMulti() && (
          <select className="h-pagesel" aria-label="Go to page" value={page.id} onChange={(e) => { location.hash = hrefFor(e.target.value); }}>
            {allPages().map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <span className="h-spacer" />
        <button className="h-btn" onClick={() => setPanel(!panel)} aria-pressed={panel} title="Feedback: answer the decisions and leave comments, then copy it all back to the author">{feedbackLabel}</button>
        <button className="h-btn" onClick={() => present.start()} title="Present (p): walk through the sections full screen">Present</button>
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
      </div>
      <div className="h-layout" data-outline={outlineOff ? "off" : undefined}>
        <nav className="h-outline" aria-label={isMulti() ? "Pages" : "Outline"}>
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
        </nav>
        <main className="h-main" data-width={meta.width}>
          <header className="h-head" data-header={compact ? "compact" : "full"} ref={head}>
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
          </header>
          <FeedbackCtx.Provider value={{ interactive: true, answers: am.answers, answer: am.answer }}>
            <PresentCtx.Provider value={present.state}><article className="a-content" ref={content} data-page={page.id}><Boundary key={page.id}><page.Component /></Boundary></article></PresentCtx.Provider>
          </FeedbackCtx.Provider>
          {isMulti() && <PageNav current={page.id} />}
          {rows.length > 0 && (
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
          onClearAnswers={am.clear} onJumpDecision={jumpDecision} onClose={() => { setPanel(false); setMode(false); }} />}
      </div>
      {open && <Composer anchor={open} onCancel={() => setOpen(null)} onSave={(body) => { cm.add(open, body); setOpen(null); }} existing={cm.list.filter((c) => c.anchor.id === open.id)} />}
      {present.active && (
        <div className="h-present-bar" data-slide={present.state.slide} data-slides={present.state.slides} data-step={present.state.step} data-steps={present.state.steps}>
          <button onClick={present.prev}>←</button>
          <span className="h-present-label">{present.label}</span>
          {more && <span className="h-more-hint h-present-hint" title="This slide continues below: scroll or press ↓">↓ more</span>}
          <button onClick={present.next}>→</button>
          <button onClick={present.stop}>Exit</button>
        </div>
      )}
    </div>
  );
}
