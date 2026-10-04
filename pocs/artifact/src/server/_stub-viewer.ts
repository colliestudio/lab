// STUB — used only when viewer/dist/index.html is missing (before the viewer branch is merged / built).
// Minimal page that honours the ViewerBoot contract: boots from window.__RECAP__ injected at <!--RECAP_BOOT-->.
export const STUB_VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>recap (stub viewer)</title>
<style>body{font:14px system-ui;max-width:760px;margin:24px auto;padding:0 16px}pre{white-space:pre-wrap;background:#f6f6f6;padding:8px}</style>
<!--RECAP_BOOT-->
</head><body><div id="app">loading…</div>
<script>
(async () => {
  const B = window.__RECAP__, d = B.doc, esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
  let h = "<p><i>stub viewer</i></p><h1>" + esc(d.title) + "</h1><p>" + esc(d.tldr) + "</p>";
  if (d.risk) h += "<p>risk: <b>" + esc(d.risk.level) + "</b> " + esc(d.risk.why) + "</p>";
  if (d.ask) h += "<p>ask: " + esc(d.ask) + "</p>";
  for (const s of d.sections) {
    h += '<h2 id="' + esc(s.id) + '">' + esc(s.title) + "</h2>";
    for (const b of s.blocks) h += b.type === "markdown" ? "<pre>" + esc(b.md) + "</pre>"
      : b.type === "demo" ? '<p class="demo" data-src="' + esc(b.src) + '">demo: ' + esc(b.src) + "</p>" : "<p>[" + esc(b.type) + "]</p>";
  }
  if (B.api) {
    const cs = await (await fetch(B.api + "/comments")).json();
    h += "<h2>Comments</h2><ul id='comments'>" + cs.map((c) => "<li>" + esc(c.author) + ": " + esc(c.body) + "</li>").join("") + "</ul>";
  }
  document.getElementById("app").innerHTML = h;
})();
</script></body></html>`;
