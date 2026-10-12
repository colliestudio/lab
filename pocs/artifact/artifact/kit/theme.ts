import { useSyncExternalStore } from "react";

const sub = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};
/** "light" | "dark", following the host's theme switch. */
export function useTheme(): "light" | "dark" {
  return useSyncExternalStore(sub, () => (document.documentElement.dataset.theme === "midnight" ? "dark" : "light"), () => "light");
}
