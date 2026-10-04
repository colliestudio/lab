import { useMemo } from "react";
import { Marked } from "marked";
import { highlight } from "../highlight.ts";
import { cx } from "../util.ts";

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    code({ text, lang }) {
      return `<pre class="code-pre"><code class="hljs">${highlight(text, lang || undefined)}</code></pre>`;
    },
    link({ href, text }) {
      const ext = /^https?:/.test(href);
      return `<a href="${href}"${ext ? ' target="_blank" rel="noreferrer"' : ""}>${text}</a>`;
    },
  },
});

export function mdToHtml(md: string): string {
  return marked.parse(md) as string;
}

export function Markdown({ md, className, inline }: { md: string; className?: string; inline?: boolean }) {
  const html = useMemo(() => (inline ? (marked.parseInline(md) as string) : mdToHtml(md)), [md, inline]);
  if (inline) return <span className={cx("md", className)} dangerouslySetInnerHTML={{ __html: html }} />;
  return <div className={cx("md", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
