// Fake app screenshots (SVG) for before-after blocks.
const W = 640, H = 400;
const frame = (title: string, nav: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#f7f7f8"/>
<rect width="${W}" height="36" fill="#ffffff"/><line x1="0" y1="36" x2="${W}" y2="36" stroke="#e4e4e7"/>
<circle cx="18" cy="18" r="6" fill="#6366f1"/><text x="32" y="22" font-size="12" font-weight="600" fill="#18181b">relay</text>
<text x="96" y="22" font-size="11" fill="#71717a">acme / production</text>
<rect x="0" y="37" width="150" height="${H - 37}" fill="#ffffff"/><line x1="150" y1="37" x2="150" y2="${H}" stroke="#e4e4e7"/>
${nav}
<text x="170" y="68" font-size="16" font-weight="600" fill="#18181b">${title}</text>
${body}
</svg>`;

const navItem = (y: number, label: string, on = false, badge?: string) =>
  `<rect x="8" y="${y - 14}" width="134" height="22" rx="5" fill="${on ? "#eef2ff" : "none"}"/>` +
  `<text x="18" y="${y + 1}" font-size="11.5" fill="${on ? "#4338ca" : "#3f3f46"}" font-weight="${on ? 600 : 400}">${label}</text>` +
  (badge ? `<rect x="112" y="${y - 10}" width="22" height="15" rx="7.5" fill="#fee2e2"/><text x="123" y="${y + 1}" font-size="9.5" text-anchor="middle" fill="#b91c1c" font-weight="600">${badge}</text>` : "");

const row = (y: number, cells: [string, number, string?][], h = 30) =>
  `<line x1="170" y1="${y + h}" x2="${W - 20}" y2="${y + h}" stroke="#ececef"/>` +
  cells.map(([t, x, c]) => `<text x="${x}" y="${y + 19}" font-size="11" fill="${c ?? "#3f3f46"}">${t}</text>`).join("");

export const shotBefore = frame("Events",
  navItem(66, "Destinations") + navItem(92, "Events", true) + navItem(118, "Settings"),
  `<rect x="170" y="84" width="${W - 190}" height="290" rx="8" fill="#fff" stroke="#e4e4e7"/>` +
  row(84, [["EVENT", 184, "#a1a1aa"], ["TOPIC", 330, "#a1a1aa"], ["STATUS", 450, "#a1a1aa"], ["TIME", 540, "#a1a1aa"]]) +
  [["evt_93a", "order.created", "delivered", "#15803d"], ["evt_93b", "order.paid", "delivered", "#15803d"],
   ["evt_93c", "order.paid", "retrying…", "#b45309"], ["evt_93d", "user.updated", "delivered", "#15803d"],
   ["evt_93e", "order.shipped", "retrying…", "#b45309"], ["evt_93f", "order.created", "delivered", "#15803d"],
   ["evt_940", "user.created", "delivered", "#15803d"], ["evt_941", "order.paid", "delivered", "#15803d"]]
    .map(([e, t, s, c], i) => row(114 + i * 30, [[e, 184], [t, 330], [s, 450, c], [`${i * 3 + 1}m ago`, 540, "#71717a"]])).join(""));

export const shotAfter = frame("Failed deliveries",
  navItem(66, "Destinations") + navItem(92, "Events") + navItem(118, "Failed deliveries", true, "3") + navItem(144, "Settings"),
  `<text x="170" y="88" font-size="11" fill="#71717a">Deliveries that ran out of retries (12 attempts over ~9 h).</text>` +
  `<rect x="170" y="102" width="${W - 190}" height="128" rx="8" fill="#fff" stroke="#e4e4e7"/>` +
  row(102, [["DESTINATION", 184, "#a1a1aa"], ["LAST ERROR", 318, "#a1a1aa"], ["TRIES", 470, "#a1a1aa"], ["FAILED", 515, "#a1a1aa"]]) +
  [["hooks.acme.dev/in", "503 Service Unavailable", "2h ago"], ["crm.acme.dev/wh", "connect timeout", "5h ago"], ["hooks.acme.dev/in", "503 Service Unavailable", "8h ago"]]
    .map(([d, e, t], i) => row(132 + i * 32, [[d, 184], [e, 318, "#b91c1c"], ["12", 476], [t, 515, "#71717a"]], 32) +
      `<rect x="${W - 82}" y="${139 + i * 32}" width="54" height="20" rx="5" fill="#fff" stroke="#d4d4d8"/><text x="${W - 55}" y="${153 + i * 32}" font-size="10.5" text-anchor="middle" fill="#18181b" font-weight="500">Replay</text>`).join(""));

export const sketchAfter = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,monospace">
<rect width="${W}" height="${H}" fill="#fafafa"/>
<rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="6" fill="none" stroke="#a1a1aa" stroke-dasharray="6 4"/>
<text x="40" y="58" font-size="15" fill="#3f3f46">Failed deliveries</text>
${[0, 1, 2, 3].map((i) => `<rect x="40" y="${80 + i * 52}" width="${W - 80}" height="40" rx="4" fill="none" stroke="#a1a1aa"/>
<rect x="54" y="${94 + i * 52}" width="${140 + (i % 2) * 40}" height="12" rx="2" fill="#d4d4d8"/>
<rect x="280" y="${94 + i * 52}" width="150" height="12" rx="2" fill="#fecaca"/>
<rect x="${W - 130}" y="${88 + i * 52}" width="70" height="24" rx="4" fill="none" stroke="#6366f1"/><text x="${W - 95}" y="${104 + i * 52}" font-size="11" text-anchor="middle" fill="#6366f1">Replay</text>`).join("")}
<text x="40" y="${H - 44}" font-size="11" fill="#71717a">sketch · columns: destination, last error, attempts, failed at</text>
</svg>`;
