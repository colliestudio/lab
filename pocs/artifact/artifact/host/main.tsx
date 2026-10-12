import { createRoot } from "react-dom/client";
import { Host } from "./Host.tsx";
import { Boundary } from "./Boundary.tsx";
import { allPages } from "../kit/pages.ts";

export function mount() {
  const stored = localStorage.getItem("artifact-theme");
  const dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.dataset.theme = "midnight";
  (window as unknown as { __artifactPages?: string[] }).__artifactPages = allPages().map((p) => p.id); // shot --page all reads the real page list
  createRoot(document.getElementById("root")!).render(<Boundary><Host /></Boundary>);
}
