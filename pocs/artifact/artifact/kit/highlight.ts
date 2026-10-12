import hljs from "highlight.js/lib/core";
import go from "highlight.js/lib/languages/go";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import ini from "highlight.js/lib/languages/ini";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";

for (const [n, l] of Object.entries({ go, typescript, javascript, json, yaml, sql, bash, python, rust, css, xml, ini, markdown, diff }))
  hljs.registerLanguage(n, l);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["sh", "shell"], { languageName: "bash" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["html"], { languageName: "xml" });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  return esc(code);
}

/**
 * Highlight a sequence of lines as one text (so multi-line strings/comments colour right), then split back
 * into per-line HTML, re-opening any spans that cross line breaks.
 */
export function highlightLines(lines: string[], lang?: string): string[] {
  const html = highlight(lines.join("\n"), lang);
  const out: string[] = [];
  let open: string[] = [];
  for (const raw of html.split("\n")) {
    let line = open.join("") + raw;
    const tags = raw.match(/<span[^>]*>|<\/span>/g) ?? [];
    for (const t of tags) (t === "</span>" ? open.pop() : open.push(t));
    line += "</span>".repeat(open.length);
    out.push(line);
  }
  return out;
}

export { hljs };
