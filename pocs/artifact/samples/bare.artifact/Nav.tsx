import { Link, usePages, useRoute, type PageEntry } from "artifact";
import "./bare.css";

export function Frame({ children }: { children: React.ReactNode }) {
  const pages = usePages(), { page } = useRoute();
  return (
    <div className="b-root">
      <nav className="b-nav" aria-label="Pages">
        {pages.map((p: PageEntry) => <Link key={p.id} to={p.id}><span aria-current={p.id === page ? "page" : undefined}>{p.title}</span></Link>)}
      </nav>
      <div className="b-stage">{children}</div>
    </div>
  );
}
