---
kind: review
title: "Collie UI first slice: tokens → recipes → zero-style components"
tldr: The first commit sets up a three-layer design system (DTCG tokens → Tailwind slot recipes → unstyled React components on Base UI) with four swappable themes, a compact density, and Storybook/Playroom to judge it against six POC screens.
status: ready
risk: medium
risk_why: Every theme and the density block emit the full semantic layer, so `data-density="compact"` resets the colours, radius and borders of whichever theme is active.
ask: Approve the layering and the three rules; decide the density fix before more themes are added; check the stale README lines.
repo: alexluong/collie-ui
base: (empty)
head: c001c14
author: recap-lab samples agent
date: 2026-10-05
---

```map
groups:
  - { id: packages, label: packages/ }
  - { id: apps, label: apps/ }
nodes:
  - { id: tokens, label: "@collie/tokens (DTCG → CSS vars)", kind: module, change: added, group: packages, section: tokens, files: [packages/tokens/build.mjs, packages/tokens/src/semantic.tokens.json, packages/tokens/scripts/*] }
  - { id: themes, label: Themes + density, kind: config, change: added, group: packages, section: themes, files: [packages/tokens/src/theme/*, packages/tokens/src/density/*] }
  - { id: recipes, label: "@collie/recipes-tw (slot recipes)", kind: module, change: added, group: packages, section: recipes, files: [packages/recipes-tw/**] }
  - { id: ui, label: "@collie/ui (zero-style React)", kind: module, change: added, group: packages, section: components, files: [packages/ui/**] }
  - { id: format, label: "@collie/format (dates, numbers, ranges)", kind: module, change: added, group: packages, section: format, files: [packages/format/**] }
  - { id: base-ui, label: Base UI (headless), kind: external, change: unchanged }
  - { id: tailwind, label: Tailwind v4, kind: external, change: unchanged }
  - { id: workshop, label: Workshop (Storybook + POC screens), kind: ui, change: added, group: apps, section: workshop, files: [apps/workshop/**] }
  - { id: playroom, label: Playroom (all themes side by side), kind: ui, change: added, group: apps, section: workshop, files: [apps/playroom/**] }
  - { id: dev-tooling, label: mise tasks + per-worktree ports, kind: config, change: added, section: tooling, files: [mise.toml, scripts/*, eslint.config.js] }
  - { id: generated, label: Lockfile + Radix primitives + configs, kind: config, change: added, mechanical: true, section: mechanical, files: [pnpm-lock.yaml, packages/tokens/src/primitive.tokens.json] }
edges:
  - { from: themes, to: tokens, label: override values }
  - { from: tokens, to: recipes, label: "utilities (tailwind.css)" }
  - { from: tailwind, to: recipes, label: compiles class strings }
  - { from: recipes, to: ui, label: "slots({tone, size})" }
  - { from: base-ui, to: ui, label: behaviour }
  - { from: format, to: ui, label: TimeRangePicker }
  - { from: ui, to: workshop, label: stories + POC screens }
  - { from: ui, to: playroom, label: compositions }
```

Dependencies point one way: `tokens ← recipes-tw ← ui`. Components hold no class strings, recipes name only semantic tokens, and state travels as `data-*` attributes; a theme is token values only. Wireframe is a theme that doubles as a conformance test: anything still looking polished in it broke a rule. Nothing is published yet: packages are `private`, `ui` and `recipes-tw` export `.ts` source, and `tokens/dist` is built locally.

```questions
- q: How should compact density stop resetting the active theme?
  options: ["emit only the tokens a density file changes", "keep full blocks, scope density after themes (:where() / theme-scoped selectors)"]
  recommend: emit only the tokens a density file changes
  why: It is the rule build.mjs line 18 already states, keeps the density block small, and makes the contract.d.ts check meaningful again.
```

## Tokens: DTCG source → CSS variables {#tokens}

`build.mjs` runs Style Dictionary over three layers (Radix primitive ramps → ~84 semantic tokens → per-theme/density overrides) and writes `theme.css` (`--collie-*` vars per selector), `tailwind.css` (an `@theme` that drops Tailwind's own scales, so `bg-blue-500` and `p-4` don't compile), a `contract.d.ts` of token names and `tokens.json` for the docs.

```flow
flowchart LR
  R["@radix-ui/colors"] -->|sync-radix.mjs, checked in| P[primitive.tokens.json]
  P --> S[semantic.tokens.json]
  T["theme/*.tokens.json<br/>density/*.tokens.json"] --> B[build.mjs]
  S --> B
  B --> C["theme.css<br/>:root + [data-theme] + [data-density]"]
  B --> W["tailwind.css<br/>@theme inline"]
  B --> K[contract.d.ts]
  B --> J[tokens.json → docs]
```

```diff file=packages/tokens/build.mjs lines=18,163-199
@18: The intended rule. The code below does the opposite: every block gets the whole semantic layer.
@167: The filter keeps every semantic token, not only the ones the file changes.
@185: Themes: full layer per [data-theme] block.
@194: Density: the same full layer, emitted after the themes; this is the bug in the callout below.
```

```callout tone=risk
**Compact density resets the theme.** Each `[data-theme]` and the `[data-density="compact"]` block carry all 84 semantic tokens (checked in a scratch build: 84 per block). Both attributes sit on `<html>`, the selectors have equal specificity, and density comes last in `theme.css`, so midnight + compact renders light colours and wireframe + compact gets rounded, solid, shadowed borders back. Fix: emit only the tokens a density file actually changes (or order density blocks with a `:where()` / theme-scoped selector). Line 18's comment ("Themes emit ONLY the tokens they override") describes the intended behaviour, not the current one.
```

```callout tone=warn
`contract.d.ts` says it exists "so CI can assert a theme defines them all", but no task (`mise run check`) asserts it; with full-layer emission it can't fail anyway.
```

```files
packages/tokens/build.mjs: layers, varName mapping, $ramps expansion, watch mode
packages/tokens/src/semantic.tokens.json: the public token API; recipes may reference only these
packages/tokens/scripts/sync-radix.mjs: regenerates primitive.tokens.json (checked in)
```

## Themes and density {#themes}

Four themes, all token values: **polished** (`:root`, no file), **midnight** (repoints every ramp to its Radix dark twin with `$ramps`, plus one hand-set colour), **sandstone** (warm ramps, rounder radius), **wireframe** (grey, radius 0, mono, dashed, no shadow). `compact` tightens the spacing and text scales.

```diff file=packages/tokens/src/theme/wireframe.tokens.json hunks=1
@2: The rule in one line: values only, no component or recipe changes.
@41: Radius 0 everywhere; recipes keep saying rounded-md.
@56: Mono font is how "unfinished" reads at a glance.
@62: border-style is a token, so recipes use the BORDER helper instead of Tailwind's border-solid.
@68: No shadows: a polished-looking surface in wireframe means a recipe hard-coded a style.
```

```code file=packages/tokens/src/density/compact.tokens.json lines=26-39
@27: Only space and text change here, yet build.mjs emits all 84 semantic tokens for this block (see the risk in Tokens).
```

```files
packages/tokens/src/theme/midnight.tokens.json: "$ramps → dark ramps; on-warning set by hand"
packages/tokens/src/theme/sandstone.tokens.json: warm ramps, rounder
packages/tokens/src/theme/wireframe.tokens.json: conformance theme
packages/tokens/src/density/compact.tokens.json: space + text scale
```

## Recipes: every class string, as slot recipes {#recipes}

`@collie/recipes-tw` holds all styling as `tailwind-variants` slot recipes (badge, box, button, field, media, overlay, popover, stack, table, tabs, text). Tone and emphasis are independent axes: tone sets component-tier CSS variables, emphasis reads them.

```diff file=packages/recipes-tw/src/button.ts hunks=1
@4: Tone writes --btn-* variables; emphasis only reads them, so 3 tones × 3 emphases need 6 entries, not 9.
@12: BORDER puts width and style on tokens (see wireframe's dashed borders).
@16: State styled from the data attribute the component sets; no loading prop reaches the recipe.
@66: Secondary goes through component-tier tokens (--collie-button-secondary-*), so a theme can turn the outline into a tonal fill without a second recipe.
@83: Sizes use the semantic space scale, which compact density rewrites.
```

## Components: zero-style React on Base UI {#components}

`@collie/ui` is ~1.3k lines of React (Badge, Box/Stack/Inline/Columns, Button, Dialog/Drawer, Avatar, Table, Text/Heading, fields, Tabs, TimeRangePicker). Components call a recipe and set `data-*` state; there are no class-string literals in `packages/ui` (grep: 0). Behaviour (popover, dialog, tabs) comes from Base UI.

```diff file=packages/ui/src/button.tsx hunks=1
@23: The only styling call: resolve the recipe's slots.
@29: Loading implies disabled unless the caller says otherwise.
@30: State as data: a new state never changes the component's signature.
```

```files
packages/ui/src/time-range.tsx: biggest component (203 lines); relative / absolute / around tabs, time zone select
packages/ui/src/field.tsx: TextField, TextAreaField, SelectField, Checkbox
```

## Format: dates, numbers, time ranges {#format}

`@collie/format` keeps formatting out of components: zoned date-times, numbers/money, and a `TimeRange` value that stays relative until resolved, so a saved "last 6 hours" view re-resolves instead of freezing.

```data-model
entities:
  - name: TimeRange
    change: added
    note: union on kind
    fields:
      - { name: "relative {amount, unit}", change: added, note: "resolved against now: [now - amount, now]" }
      - { name: "absolute {start, end}", type: Instant (ISO), change: added }
      - { name: "around {at, amount, unit}", change: added, note: "window of ± amount around at" }
  - name: RelativeUnit
    change: added
    fields:
      - { name: minute | hour | day, change: added }
```

```diff file=packages/format/src/time-range.ts hunks=1
@24: now is passed in, never read from the clock: stories and the smoke test stay deterministic.
@37: "Around" is ± amount, so "30 minutes around 14:00" is a 60-minute window. Worth a label check in the picker.
@91: Labels reuse the preset names when the range matches one.
```

## Workshop, POC screens, Playroom {#workshop}

Storybook (`apps/workshop`) carries the component stories, ten docs pages (tokens rendered from `tokens.json`, never hand-written) and six POC screens (dashboard, tenant list/detail, integrations, orders, settings) that test the system on app-shaped UI. A theme/density toolbar sets the attributes on `<html>`, so portalled overlays follow. Playroom renders any composition in all four themes side by side.

```diff file=apps/workshop/scripts/smoke.mjs hunks=1
@15: The only automated runtime check: server-render the six POC screens through Vite SSR.
@28: Catches throw-on-render and hook misuse; not visual or interaction regressions.
```

```callout tone=info
No screenshots are checked in, so this review has no before/after. Quickest look: `mise run dev`, Playroom with the default example shows the four themes side by side; set the Compact frame setting to see the density bug above.
```

```files
apps/workshop/.storybook/preview.tsx: theme + density toolbar on documentElement
apps/workshop/src/poc/tenant-list.tsx: largest POC screen (280 lines)
apps/playroom/playroom.config.js: babel + extensionAlias so .ts workspace source compiles
apps/playroom/src/FrameComponent.tsx: theme per frame document
```

## Dev tooling: mise tasks, per-worktree ports {#tooling}

`mise run setup | dev | fix | check | smoke`; `check` = prettier, eslint, `tsc --build`, app typechecks and the smoke render. `setup` writes a gitignored `.env` with a 10-port range per worktree, hashed from the directory name and probed for free, so parallel worktrees don't collide.

```diff file=scripts/setup-env.mjs hunks=1
@24: Written once, never regenerated; delete .env to get a new range.
@33: Probes the way a dev server binds (all interfaces, dual-stack); 127.0.0.1 probes miss IPv6 listeners.
@42: Stable seed per worktree name, then walk to the next free slot.
```

```callout tone=warn
Leftovers to fix: `pnpm-workspace.yaml` has `allowBuilds: esbuild: set this to true or false` (pnpm's placeholder, while `.npmrc` already allows esbuild builds); the README says Playroom's port is "reserved; nothing listens there yet" and "every component that isn't Button" is not here yet (both stale), and points notes at the cs repo (they live in the workspace vault now).
```

```files
mise.toml: tasks; node 22.22.0, pnpm 11.20.0
README.md: shape, rules, setup (some lines stale)
pnpm-workspace.yaml: allowBuilds placeholder
```

## Generated and config {#mechanical .mechanical}

`pnpm-lock.yaml` (9.9k lines), `primitive.tokens.json` (747 lines, generated by `sync-radix.mjs` from `@radix-ui/colors`), and root configs (tsconfig, prettier, eslint, `.npmrc` with `node-linker=isolated` so packages can't import undeclared deps).

```checklist
- mise run setup && mise run check (prettier, eslint, tsc, smoke)
- "mise run dev → Storybook, Theme = Midnight, Density = Compact: canvas should stay dark (fails today)"
- grep -rn 'className="' packages/ui/src → nothing
```
