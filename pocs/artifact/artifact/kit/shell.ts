// The one HTML shell of a built artifact. Shared by the build (node) and the host's Download button (browser),
// so a downloaded file is byte-for-byte the same shape as the one that was opened.
export const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** `css` and `js` must already be escaped for inlining (the build does it; the browser passes the element text back as is). */
export function shell(title: string, css: string, js: string, extra = ""): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${htmlEscape(title)}</title><style id="a-css">${css}</style></head><body><div id="root"></div>${extra}<script id="a-js">${js}</script></body></html>\n`;
}
