// Docs can come from anyone (the hosted server serves uploaded bundles): every HTML string the viewer injects
// from doc content (markdown, Mermaid SVG) goes through DOMPurify first.
import DOMPurify from "dompurify";

export function cleanHtml(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** Mermaid output (already rendered with securityLevel "strict"): SVG + its <style> + HTML labels in foreignObject. */
export function cleanSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject", "style"],
    ADD_ATTR: ["dominant-baseline", "text-anchor"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}
