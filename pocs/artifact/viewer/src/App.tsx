import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Comment, Doc, Level, ViewerBoot } from "../../src/model.ts";
import { Ctx, useViewer, type ViewerCtx } from "./ctx.tsx";
import { commentsApi, makeGetFile } from "./boot.ts";
import { Headline } from "./components/Headline.tsx";
import { MapView } from "./components/MapView.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { SectionView, autoFiles, explicitDiffFiles } from "./components/SectionView.tsx";
import { FileTree } from "./blocks/files.tsx";
import { FileDiff } from "./blocks/diff.tsx";
import { Icon } from "./components/icons.tsx";
import { LEVELS, cx, diffId, nodeForSection, orderedSections, plural, sectionDomId } from "./util.ts";

type Theme = "light" | "dark";
const clampLevel = (n: number) => Math.max(0, Math.min(3, n)) as Level;

function readHash(): { level: Level; focus: string | null } {
  const m = location.hash.match(/^#\/L([0-3])(?:\/(.+))?$/);
  return m ? { level: Number(m[1]) as Level, focus: m[2] ? decodeURIComponent(m[2]) : null } : { level: 1, focus: null };
}

const systemTheme = (): Theme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export function App({ boot }: { boot: ViewerBoot }) {
  const doc = boot.doc;
  const getFile = useMemo(() => makeGetFile(boot), [boot]);
  const initial = useMemo(readHash, []);
  const [level, setLevelRaw] = useState<Level>(initial.level);
  const [focus, setFocusRaw] = useState<string | null>(initial.focus);
  const [themePref, setThemePref] = useState<Theme | null>(() => (localStorage.getItem("recap.theme") as Theme) || null);
  const [sysTheme, setSysTheme] = useState<Theme>(systemTheme);
  const theme = themePref ?? sysTheme;
  const [overlay, setOverlay] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const scrollAnchor = useRef<{ id: string; top: number } | null>(null);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSysTheme(systemTheme());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (theme === "dark") el.dataset.theme = "midnight"; else delete el.dataset.theme;
    el.style.colorScheme = theme;
  }, [theme]);
  useEffect(() => { document.title = `${doc.title} · ${doc.kind === "plan" ? "plan" : "review"}`; }, [doc]);

  // --- level changes keep the reader's place: remember the first visible section and restore its offset
  const setLevel = useCallback((l: Level) => {
    const secs = [...document.querySelectorAll<HTMLElement>("[data-section], #map-panel, #headline")];
    const top = 64;
    const cur = secs.find((s) => s.getBoundingClientRect().bottom > top + 8);
    scrollAnchor.current = cur ? { id: cur.id, top: cur.getBoundingClientRect().top } : null;
    setLevelRaw(clampLevel(l));
  }, []);
  useLayoutEffect(() => {
    const a = scrollAnchor.current;
    scrollAnchor.current = null;
    if (!a) return;
    const el = document.getElementById(a.id);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - a.top);
  }, [level]);

  const setFocus = useCallback((id: string | null) => {
    setFocusRaw(id);
    if (id) setLevelRaw((l) => (l < 2 ? 2 : l));
    window.scrollTo(0, 0);
    if (!id) requestAnimationFrame(() => document.getElementById("map-panel")?.scrollIntoView({ block: "start" }));
  }, []);

  // hash <-> state (focus pushes history so Back leaves focus)
  const lastFocus = useRef(focus);
  useEffect(() => {
    const h = `#/L${level}${focus ? "/" + encodeURIComponent(focus) : ""}`;
    if (location.hash === h) return;
    if (focus !== lastFocus.current) history.pushState(null, "", h); else history.replaceState(null, "", h);
    lastFocus.current = focus;
  }, [level, focus]);
  useEffect(() => {
    const on = () => { const s = readHash(); lastFocus.current = s.focus; setLevelRaw(s.level); setFocusRaw(s.focus); };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  const revealFile = useCallback((path: string) => {
    const go = (tries: number) => {
      window.dispatchEvent(new CustomEvent("recap:reveal", { detail: path }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.getElementById(diffId(path));
        if (!el) {
          if (tries > 0) { setFocusRaw(null); setLevelRaw(3); setTimeout(() => go(tries - 1), 60); }
          return;
        }
        // diffs that just mounted (e.g. inside a mechanical section that opened) missed the first event
        window.dispatchEvent(new CustomEvent("recap:reveal", { detail: path }));
        requestAnimationFrame(() => {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
        });
      }));
    };
    go(2);
  }, []);

  // comments
  const reloadComments = useCallback(() => { if (boot.api) commentsApi.list(boot.api).then(setComments, () => {}); }, [boot.api]);
  useEffect(reloadComments, [reloadComments]);
  const addComment = useCallback<ViewerCtx["addComment"]>(async (c) => {
    if (!boot.api) return;
    const author = localStorage.getItem("recap.author") || "reader";
    await commentsApi.add(boot.api, { ...c, author });
    reloadComments();
  }, [boot.api, reloadComments]);

  // keys
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "4") setLevel((Number(e.key) - 1) as Level);
      else if (e.key === "+" || e.key === "=") setLevel(clampLevel(level + 1));
      else if (e.key === "-" || e.key === "_") setLevel(clampLevel(level - 1));
      else if (e.key === "Escape" && focus) setFocus(null);
      else if (e.key === "t") setThemePref(theme === "dark" ? "light" : "dark");
      else if (e.key === "p" && doc.planLink) setOverlay((o) => !o);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [level, focus, theme, setLevel, setFocus, doc.planLink]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setThemePref(next);
    localStorage.setItem("recap.theme", next);
  };

  const ctx: ViewerCtx = { doc, getFile, level, setLevel, theme, focus, setFocus, revealFile, api: boot.api, comments, addComment };
  const focused = focus ? doc.sections.find((s) => s.id === focus) : undefined;
  const showOutline = level >= 2;

  return (
    <Ctx.Provider value={ctx}>
      <TopBar doc={doc} theme={theme} toggleTheme={toggleTheme} overlay={overlay} setOverlay={setOverlay} />
      <div className={cx("layout", showOutline && "with-outline", `lvl-${level}`)}>
        {showOutline && <Outline />}
        <main className="content">
          {focused ? (
            <FocusView sectionId={focused.id} overlay={overlay} />
          ) : (
            <>
              <Headline overlay={overlay} setOverlay={setOverlay} />
              {level === 0 && <NextLevel doc={doc} />}
              {level >= 1 && <MapPanel overlay={overlay} />}
              {level >= 2 && <Areas />}
              {level >= 3 && <AllFiles />}
            </>
          )}
        </main>
      </div>
    </Ctx.Provider>
  );
}

function TopBar({ doc, theme, toggleTheme, overlay, setOverlay }: {
  doc: Doc; theme: Theme; toggleTheme: () => void; overlay: boolean; setOverlay: (v: boolean) => void;
}) {
  const { level, setLevel } = useViewer();
  return (
    <div className="topbar">
      <div className="tb-left">
        <span className="tb-mark" aria-hidden><Icon name="layers" size={14} /></span>
        <span className="tb-kind">{doc.kind === "plan" ? "VISUAL PLAN" : "VISUAL REVIEW"}</span>
        <span className="tb-title" title={doc.title}>{doc.title}</span>
      </div>
      <div className="zoom" role="group" aria-label="Zoom level">
        <button className="zbtn step" onClick={() => setLevel(clampLevel(level - 1))} disabled={level === 0} title="Zoom out (−)">
          <Icon name="minus" size={13} />
        </button>
        <div className="zseg">
          {LEVELS.map((l) => (
            <button key={l.n} className={cx("zbtn", level === l.n && "on", level > l.n && "above")}
              onClick={() => setLevel(l.n)} title={`${l.name} (key ${l.n + 1})`} aria-pressed={level === l.n}>
              <span className="zdot">{l.n}</span>{l.name}
            </button>
          ))}
        </div>
        <button className="zbtn step" onClick={() => setLevel(clampLevel(level + 1))} disabled={level === 3} title="Zoom in (+)">
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="tb-right">
        {doc.planLink && level >= 1 && (
          <button className={cx("btn small", overlay && "on")} onClick={() => setOverlay(!overlay)} title="Compare with plan (p)">
            <Icon name="target" size={13} /> vs plan
          </button>
        )}
        <button className="btn icon" onClick={toggleTheme} title="Toggle theme (t)" aria-label="Toggle theme">
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
      </div>
    </div>
  );
}

function NextLevel({ doc }: { doc: Doc }) {
  const { setLevel } = useViewer();
  const nodes = doc.map.nodes.filter((n) => n.change !== "unchanged").length;
  return (
    <button className="next-level" onClick={() => setLevel(1)}>
      <span>Zoom in to the <b>map</b>: {plural(nodes, "changed area")}, {plural(doc.map.edges.length, "connection")}</span>
      <span className="kbd">2</span>
    </button>
  );
}

function LevelRule({ n, note }: { n: number; note?: string }) {
  return (
    <div className="level-rule">
      <span className="lr-tag">{n} · {LEVELS[n].name}</span>
      {note && <span className="lr-note">{note}</span>}
    </div>
  );
}

function MapPanel({ overlay }: { overlay: boolean }) {
  const { doc, setFocus } = useViewer();
  return (
    <section className="map-panel" id="map-panel">
      <LevelRule n={1} note="hover a node for its summary · click to focus" />
      <div className="card map-card">
        <MapView overlay={overlay} onOpen={setFocus} />
      </div>
      {doc.overview && <Markdown md={doc.overview} className="overview prose" />}
    </section>
  );
}

function Areas() {
  const { doc, level } = useViewer();
  const secs = orderedSections(doc);
  const main = secs.filter((s) => !s.mechanical);
  const mech = secs.filter((s) => s.mechanical);
  return (
    <div className="areas">
      <LevelRule n={2} note={`${plural(main.length, "area")}${mech.length ? ` · ${mech.length} mechanical` : ""}`} />
      {main.map((s) => <SectionView key={s.id} section={s} level={level} />)}
      {mech.length > 0 && (
        <div className="mech-group">
          <div className="mech-title muted">Mechanical changes</div>
          {mech.map((s) => <SectionView key={s.id} section={s} level={level} />)}
        </div>
      )}
    </div>
  );
}

function AllFiles() {
  const { doc } = useViewer();
  if (doc.files.length === 0) return null;
  const explicit = explicitDiffFiles(doc);
  const covered = new Set([...explicit, ...doc.sections.flatMap((s) => autoFiles(doc, s.id).map((f) => f.path))]);
  const rest = doc.files.filter((f) => !covered.has(f.path));
  return (
    <section className="all-files" id="all-files" data-section="all-files">
      <LevelRule n={3} note={`all ${plural(doc.files.length, "changed file")}`} />
      <div className="card pad">
        <FileTree entries={doc.files.map((f) => ({ path: f.path, file: f }))} />
      </div>
      {rest.length > 0 && (
        <div className="rest-files">
          <div className="blk-label">Not covered by any area</div>
          {rest.map((f) => <FileDiff key={f.path} file={f} defaultOpen={!f.mechanical} />)}
        </div>
      )}
    </section>
  );
}

function Outline() {
  const { doc, level, focus, setFocus } = useViewer();
  const secs = orderedSections(doc);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (focus) return;
    const els = [...document.querySelectorAll<HTMLElement>("[data-section]")];
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.section!);
    }, { rootMargin: "-64px 0px -60% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [focus, level, doc]);
  const cur = focus ?? active;
  const go = (id: string) => {
    if (focus) { setFocus(id); return; }
    document.getElementById(sectionDomId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  let mechStarted = false;
  return (
    <nav className="outline" aria-label="Sections">
      <div className="ol-title">{focus ? "Areas" : "On this page"}</div>
      {!focus && <a className="ol-item top" href="#headline" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Headline</a>}
      {!focus && <a className="ol-item top" href="#map-panel" onClick={(e) => { e.preventDefault(); document.getElementById("map-panel")?.scrollIntoView({ behavior: "smooth" }); }}>Map</a>}
      {focus && <button className="ol-item top" onClick={() => setFocus(null)}><Icon name="arrowLeft" size={12} /> Map</button>}
      <div className="ol-sep" />
      {secs.map((s) => {
        const n = nodeForSection(doc, s.id);
        const head = s.mechanical && !mechStarted ? ((mechStarted = true), <div key="mh" className="ol-sub">Mechanical</div>) : null;
        return [
          head,
          <button key={s.id} className={cx("ol-item", cur === s.id && "on", s.mechanical && "mech")} onClick={() => go(s.id)}>
            <span className={cx("dot", n && `ch-${n.change}`)} />{s.title}
          </button>,
        ];
      })}
      {level >= 3 && !focus && doc.files.length > 0 && (
        <>
          <div className="ol-sep" />
          <button className={cx("ol-item", cur === "all-files" && "on")} onClick={() => document.getElementById("all-files")?.scrollIntoView({ behavior: "smooth" })}>
            All files <span className="muted">{doc.files.length}</span>
          </button>
        </>
      )}
      <div className="ol-keys muted">
        <span><span className="kbd">1</span>–<span className="kbd">4</span> zoom</span>
        {focus && <span><span className="kbd">Esc</span> back to map</span>}
      </div>
    </nav>
  );
}

function FocusView({ sectionId, overlay }: { sectionId: string; overlay: boolean }) {
  const { doc, level, setFocus } = useViewer();
  const secs = orderedSections(doc);
  const idx = secs.findIndex((s) => s.id === sectionId);
  const section = secs[idx];
  const node = nodeForSection(doc, sectionId);
  const byId = (id: string) => doc.map.nodes.find((n) => n.id === id);
  const incoming = node ? doc.map.edges.filter((e) => e.to === node.id).map((e) => ({ e, n: byId(e.from) })) : [];
  const outgoing = node ? doc.map.edges.filter((e) => e.from === node.id).map((e) => ({ e, n: byId(e.to) })) : [];
  const prev = secs[idx - 1], next = secs[idx + 1];

  const Neighbour = ({ n, label, dir }: { n?: ReturnType<typeof byId>; label?: string; dir: "in" | "out" }) => {
    if (!n) return null;
    const has = n.section && doc.sections.some((s) => s.id === n.section);
    const body = (
      <>
        <Icon name={dir === "in" ? "arrowLeft" : "arrowRight"} size={12} className="nb-arrow" />
        <span className={cx("dot", `ch-${n.change}`)} />
        <span className="nb-label">{n.label}</span>
        {label && <span className="nb-edge">{label}</span>}
      </>
    );
    return has
      ? <button className="nb" onClick={() => setFocus(n.section!)}>{body}</button>
      : <span className="nb ctx" title="context (unchanged)">{body}</span>;
  };

  return (
    <div className="focus-view">
      <nav className="crumbs">
        <button className="crumb" onClick={() => setFocus(null)}><Icon name="arrowLeft" size={13} /> Map</button>
        <span className="crumb-sep">›</span>
        <span className="crumb cur">{section.title}</span>
        <span className="sec-spacer" />
        <span className="muted small">level {Math.max(level, 2)} · <span className="kbd">Esc</span> back</span>
      </nav>
      <div className="card focus-context">
        <MapView compact focusSection={sectionId} overlay={overlay} onOpen={setFocus} />
        {(incoming.length > 0 || outgoing.length > 0) && (
          <div className="neighbours">
            {incoming.length > 0 && (
              <div className="nb-col"><div className="tile-label">Called by / fed from</div>
                {incoming.map(({ e, n }, i) => <Neighbour key={i} n={n} label={e.label} dir="in" />)}</div>
            )}
            {outgoing.length > 0 && (
              <div className="nb-col"><div className="tile-label">Calls / feeds</div>
                {outgoing.map(({ e, n }, i) => <Neighbour key={i} n={n} label={e.label} dir="out" />)}</div>
            )}
          </div>
        )}
      </div>
      <SectionView key={section.id} section={section} level={Math.max(level, 2) as Level} focused />
      <div className="focus-nav">
        {prev ? <button className="fn prev" onClick={() => setFocus(prev.id)}><span className="muted">← Previous</span>{prev.title}</button> : <span />}
        {next ? <button className="fn next" onClick={() => setFocus(next.id)}><span className="muted">Next →</span>{next.title}</button> : <span />}
      </div>
    </div>
  );
}
