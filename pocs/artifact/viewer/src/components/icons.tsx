import type { NodeKind } from "../../../src/model.ts";

// Small stroke icons (lucide-style paths, drawn on a 24 grid).
const P: Record<string, string> = {
  service: "M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01",
  module: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  ui: "M3 5h18v14H3z M3 9h18 M7 7h.01",
  db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  api: "M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3 M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3",
  queue: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5",
  job: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  external: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  config: "M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M16 4v4 M10 10v4 M18 16v4",
  doc: "M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  chevron: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  comment: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  half: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18",
  x: "M6 6l12 12 M18 6L6 18",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  play: "M7 4l13 8-13 8z",
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  arrowLeft: "M19 12H5 M11 6l-6 6 6 6",
  arrowRight: "M5 12h14 M13 6l6 6-6 6",
  alert: "M12 3l10 18H2z M12 10v4 M12 17.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7.5h.01",
  flag: "M5 21V4 M5 4h11l-2 4 2 4H5",
  diamond: "M12 3l9 9-9 9-9-9z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 12h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  ext: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5",
  download: "M12 4v11 M7 10l5 5 5-5 M5 20h14",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof P | NodeKind | string; size?: number; className?: string }) {
  const d = P[name] ?? P.module;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.split(" M").map((seg, i) => <path key={i} d={i === 0 ? seg : "M" + seg} />)}
    </svg>
  );
}

/** Raw path data, for drawing icons inside the map SVG. */
export const iconPaths = (name: string) => (P[name] ?? P.module).split(" M").map((s, i) => (i === 0 ? s : "M" + s));
