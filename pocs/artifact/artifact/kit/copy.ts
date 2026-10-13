// Copy text to the clipboard on any origin. `navigator.clipboard` exists only on secure origins (https, localhost), and
// artifacts are often served over plain http, so fall back to a hidden textarea + execCommand, then to a dialog with
// the text selected for the reader to copy by hand.

function viaTextarea(s: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = s; ta.setAttribute("readonly", ""); ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select(); ta.setSelectionRange(0, s.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove(); prev?.focus?.();
  return ok;
}

function selectDialog(s: string): void {
  const wrap = document.createElement("div");
  wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-label", "Copy"); wrap.setAttribute("data-chrome", ""); wrap.setAttribute("data-copy-dialog", "");
  wrap.style.cssText = "position:fixed;inset:0;z-index:90;display:grid;place-items:center;background:rgba(0,0,0,.35)";
  const box = document.createElement("div");
  box.style.cssText = "width:min(560px,92vw);padding:1rem;border-radius:12px;background:var(--collie-color-canvas,#fff);color:var(--collie-color-fg,#111);border:1px solid var(--collie-color-border,#ccc);box-shadow:0 10px 40px rgba(0,0,0,.3);font:14px system-ui,sans-serif;display:grid;gap:.6rem";
  const msg = document.createElement("div"); msg.textContent = "Copy is blocked here. Press Ctrl/⌘ C, then Esc.";
  const ta = document.createElement("textarea"); ta.value = s; ta.readOnly = true; ta.rows = 10;
  ta.style.cssText = "width:100%;font:12px ui-monospace,monospace;padding:.5rem;border:1px solid var(--collie-color-border,#ccc);border-radius:8px;background:transparent;color:inherit;box-sizing:border-box";
  const close = () => { wrap.remove(); removeEventListener("keydown", key, true); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const btn = document.createElement("button"); btn.textContent = "Close"; btn.onclick = close; btn.style.cssText = "justify-self:end;font:inherit;padding:.3rem .8rem;border-radius:6px;border:1px solid var(--collie-color-border,#ccc);background:transparent;color:inherit;cursor:pointer";
  wrap.onmousedown = (e) => { if (e.target === wrap) close(); };
  box.append(msg, ta, btn); wrap.append(box); document.body.appendChild(wrap);
  addEventListener("keydown", key, true);
  ta.focus(); ta.select();
}

/**
 * Copy `s` to the clipboard; works over plain http. Resolves true when copied, false when it fell back to the select-all
 * dialog (the reader copies by hand).
 */
export async function copyText(s: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(s); return true; } catch { /* denied or unfocused: fall through */ }
  }
  if (viaTextarea(s)) return true;
  selectDialog(s);
  return false;
}
