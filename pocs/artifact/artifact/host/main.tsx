import { Component, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Host } from "./Host.tsx";

class Boundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    const e = this.state.err;
    return e ? <div className="h-error"><b>This artifact threw while rendering</b><pre>{e.stack ?? String(e)}</pre></div> : this.props.children;
  }
}

export function mount(App: ComponentType) {
  const stored = localStorage.getItem("artifact-theme");
  const dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.dataset.theme = "midnight";
  createRoot(document.getElementById("root")!).render(<Boundary><Host><Boundary><App /></Boundary></Host></Boundary>);
}
