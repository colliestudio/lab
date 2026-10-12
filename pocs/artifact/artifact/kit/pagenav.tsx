import type { ReactNode } from "react";
import { pages, pageById } from "./pages.ts";
import { hrefFor, parseTo } from "./route.ts";
import { navClick, useRoute } from "./router.tsx";
import { Status } from "./layout.tsx";
import { imageSrc } from "./registry.ts";
import { cx } from "./util.ts";

/** A link to another page (and a section on it): `<Link to="journey-2#fix">…</Link>`; `to="#fix"` is a section of this page. */
export function Link({ to, children }: { to: string; children?: ReactNode }) {
  const r = parseTo(to, useRoute().page);
  return <a className="a-link" href={hrefFor(r.page, r.section)} onClick={navClick(r.page, r.section)}>{children ?? pageById(r.page)?.title ?? to}</a>;
}

/**
 * Cards linking to the pages: title, summary, status and an optional thumbnail (`page.thumb`).
 * `group="Journeys"` limits to one group, `ids={["a","b"]}` to chosen pages in that order.
 */
export function PageCards({ group, ids, cols }: { group?: string; ids?: string[]; cols?: number }) {
  const list = ids ? ids.map((i) => pageById(i)).filter((p): p is NonNullable<typeof p> => !!p) : pages().filter((p) => group == null || p.group === group);
  if (!list.length) return null;
  return (
    <div className="a-pagecards" data-c="pagecards" style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
      {list.map((p) => (
        <a key={p.id} className={cx("a-pagecard")} href={hrefFor(p.id)} onClick={navClick(p.id)}>
          {p.thumb && <div className="a-pagecard-thumb"><img src={imageSrc(p.thumb)} alt="" /></div>}
          <div className="a-pagecard-body">
            <div className="a-pagecard-head"><b>{p.icon && <span aria-hidden>{p.icon} </span>}{p.title}</b>{p.status && <Status s={p.status as never} />}</div>
            {p.summary && <div className="a-muted">{p.summary}</div>}
            {p.group && !group && <div className="a-pagecard-group">{p.group}</div>}
          </div>
        </a>
      ))}
    </div>
  );
}

