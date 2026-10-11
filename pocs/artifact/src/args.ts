// The one argv parser for all `recap` subcommands.

/** Flags that never take a value (so `--open x` keeps `x` positional). */
const BOOLEAN = new Set(["open", "root", "force", "short"]);

/**
 * `-o x --base main pos1 --flag` → {pos, flags, all}. A lone `-` (stdin) is a value. `--k=v` and `--k v` set a value; boolean flags, and a flag
 * followed by another flag (or nothing), are "true". `flags` keeps the last value; `all` every value of a repeated flag.
 */
export function parseArgs(args: string[]): { pos: string[]; flags: Record<string, string>; all: Record<string, string[]> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") && a.length > 1) {
      const [k, v] = a.replace(/^--?/, "").split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = v;
      else if (!BOOLEAN.has(k) && args[i + 1] !== undefined && (!args[i + 1].startsWith("-") || args[i + 1] === "-")) flags[k] = args[++i];
      else flags[k] = "true";
      (all[k] ??= []).push(flags[k]);
    } else pos.push(a);
  }
  return { pos, flags, all };
}
