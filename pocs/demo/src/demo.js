// Journey authoring entry point: `import { demo } from "@collie/demo"`.
// A journey file default-exports demo(title, fn); the CLI runs it.
export function demo(title, fn, options = {}) {
  return { title, fn, stage: options.stage ?? "ui", ...options };
}
