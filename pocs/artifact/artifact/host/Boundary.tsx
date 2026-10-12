import { Component, type ReactNode } from "react";

/** Shows a render error of the artifact (or a page) on the page instead of a blank screen. */
export class Boundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    const e = this.state.err;
    return e ? <div className="h-error"><b>This artifact threw while rendering</b><pre>{e.stack ?? String(e)}</pre></div> : this.props.children;
  }
}
