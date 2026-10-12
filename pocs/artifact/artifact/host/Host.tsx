import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { meta, type Source as Src } from "../kit/registry.ts";
import { Badge, Source } from "../kit/layout.tsx";
import { fmtAsOf, fmtDate, plural } from "../kit/util.ts";
import { useComments, Composer, CommentsPanel, feedbackMarkdown, anchorFor, findAnchor, type Anchor } from "./comments.tsx";
import { usePresent } from "./present.ts";
import { PresentCtx } from "../kit/present.ts";

interface OutlineItem { id: string; title: string; level: number }

function useOutline(root: React.RefObject<HTMLElement | null>) {
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
  }, [root]);
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
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); };

export function Host({ children }: { children: ReactNode }) {
  const content = useRef<HTMLElement>(null);
  const { items, active } = useOutline(content);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "midnight");
  const [depthUsed, setDepthUsed] = useState(false);
  const [depth, setDepth] = useState<number>(meta.depth ?? 4);
  const [mode, setMode] = useState(false);          // comment mode
  const [open, setOpen] = useState<Anchor | null>(null);
  const [panel, setPanel] = useState(false);
  const [outlineOff, setOutlineOff] = useState(localStorage.getItem("artifact-outline") === "off");
  const [allSources, setAllSources] = useState(false);
  const [copied, setCopied] = useState("");
  const [more, setMore] = useState(false);
  const cm = useComments(`${meta.title}|${meta.created ?? ""}`);
  const head = useRef<HTMLElement>(null);
  const present = usePresent(content, head, meta.title);

  useEffect(() => { document.title = meta.title; }, []);
  useEffect(() => {
    const el = content.current!;
    const scan = () => setDepthUsed(!!el.querySelector("[data-depth-level]"));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  useEffect(() => { document.documentElement.dataset.depth = String(depth); }, [depth]);
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

  // keys: 1-4 depth, c comment mode, p present
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (present.active) return;
      if (depthUsed && /^[1-4]$/.test(e.key)) setDepth(Number(e.key));
      else if (e.key === "c") setMode((m) => !m);
      else if (e.key === "p") present.start();
      else if (e.key === "Escape") { setMode(false); setOpen(null); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [depthUsed, present.active, present.start]);

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

  const copy = useCallback(async () => {
    const md = feedbackMarkdown(meta.title, cm.list);
    try { await navigator.clipboard.writeText(md); } catch {
      const ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setCopied("Copied"); setTimeout(() => setCopied(""), 1600);
  }, [cm.list]);

  const sources = (meta.sources ?? []).map(normSource);
  const compact = meta.header !== "full";
  return (
    <div className="h-root">
      <div className="h-bar">
        <span className="h-bar-title">{meta.title}</span>
        <span className="h-spacer" />
        {depthUsed && (
          <span className="h-seg" title="Detail level (keys 1–4)">
            {[1, 2, 3, 4].map((n) => <button key={n} aria-pressed={depth === n} onClick={() => setDepth(n)}>{n}</button>)}
          </span>
        )}
        <button className="h-btn" aria-pressed={mode} onClick={() => setMode(!mode)} title="Comment on any element (c)">Comment</button>
        <button className="h-btn" onClick={() => setPanel(!panel)} aria-pressed={panel}>{cm.list.length ? plural(cm.list.length, "note") : "Notes"}</button>
        <button className="h-btn" onClick={copy} disabled={!cm.list.length} title="Copy the comments as Markdown to paste back to the agent">{copied || "Copy feedback"}</button>
        <button className="h-btn" onClick={() => present.start()} title="Present (p): arrow keys step through sections">Present</button>
        <button className="h-btn" aria-pressed={!outlineOff} onClick={() => { setOutlineOff(!outlineOff); localStorage.setItem("artifact-outline", outlineOff ? "on" : "off"); }} title="Show or hide the outline to give the page the full width">Outline</button>
        <button className="h-btn" onClick={() => setTheme(!dark)} aria-label="Toggle theme">{dark ? "Light" : "Dark"}</button>
      </div>
      <div className="h-layout" data-outline={outlineOff ? "off" : undefined}>
        <nav className="h-outline" aria-label="Outline">
          {items.map((it) => (
            <a key={it.id} href={`#${it.id}`} className={it.id === active ? "on" : ""} style={{ paddingLeft: `${0.6 + (it.level - 1) * 0.8}rem` }}>{it.title}</a>
          ))}
        </nav>
        <main className="h-main" data-width={meta.width}>
          <header className="h-head" data-header={compact ? "compact" : "full"} ref={head}>
            <div className="h-meta">
              {meta.kind && <Badge tone="accent">{meta.kind}</Badge>}
              {meta.audience && <span title="audience"><span className="a-muted">Audience:</span> {meta.audience}</span>}
              {meta.asOf ? <span title="gathered at">as of {fmtAsOf(meta.asOf, meta.timeZone)}</span> : meta.created && <span>{fmtDate(meta.created)}</span>}
            </div>
            <h1>{meta.title}</h1>
            {meta.summary && <p className="h-summary">{meta.summary}</p>}
            {sources.length > 0 && (compact ? (
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
          <PresentCtx.Provider value={present.state}><article className="a-content" ref={content}>{children}</article></PresentCtx.Provider>
        </main>
        {panel && <CommentsPanel cm={cm} onClose={() => setPanel(false)} />}
      </div>
      {open && <Composer anchor={open} onCancel={() => setOpen(null)} onSave={(body) => { cm.add(open, body); setOpen(null); }} existing={cm.list.filter((c) => c.anchor.id === open.id)} />}
      {present.active && (
        <div className="h-present-bar" data-slide={present.state.slide} data-slides={present.state.slides} data-step={present.state.step} data-steps={present.state.steps}>
          <button onClick={present.prev}>←</button>
          <span>{present.label}</span>
          {more && <span className="h-more-hint" title="This slide continues below: scroll or press ↓">↓ more</span>}
          <button onClick={present.next}>→</button>
          <button onClick={present.stop}>Exit</button>
        </div>
      )}
    </div>
  );
}
