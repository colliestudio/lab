import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadBoot } from "./boot.ts";
import "./theme.css";
import "./app.css";

const root = createRoot(document.getElementById("root")!);
loadBoot().then(
  (boot) => root.render(boot ? <App boot={boot} /> : <Empty msg="No document: window.__RECAP__ is not set." />),
  (e) => root.render(<Empty msg={`Failed to load: ${e?.message ?? e}`} />),
);

function Empty({ msg }: { msg: string }) {
  return <div className="empty-state">{msg}</div>;
}
