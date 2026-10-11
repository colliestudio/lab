# Idea: components (custom card types as data)

Users make their own object types without writing code. A type is a JSON schema (fields) plus a small declarative look, stored inside the canvas file. Every card of that type is a form over plain data: it shows more or less detail depending on zoom, can be edited as a spreadsheet, and exports for agents.

## How it works

- **Library in the doc.** Types live at the top level of the JSON Canvas file under `x-components` (`{ persona: {…}, story: {…} }`). In the live doc that's the Yjs `meta` map, one nested map entry per type. It syncs to peers, saves with the file and is undoable.
- **Type = data.** `{ id, name, icon, color, title, fields: [{ id, label, kind, options?, to?, card? }] }`. Kinds: `text`, `longtext`, `enum`, `number`, `image` (URL), `list`, `ref` (to another card, optionally of one type). `title` = which field heads the card; `card: true` = shown at mid zoom.
- **Instance = a standard node** (`type: "text"`). Its `x-components` holds `$type` plus one key per field. Each field is its own key, so when two people edit different fields of one card, both edits survive.
- **Cards size themselves** through a layout rule (height derived from type + values, never stored).
- **Refs are values; edges are derived.** A story's `as` holds a persona id, and the plugin draws the line on an SVG layer under the cards. On save, refs also become real JSON Canvas edges and each instance gets a Markdown `text`, so Obsidian shows something readable. Both are dropped on open (values are the truth).
- **Validation in commands.** Every write goes through `components.*` commands that check values against the field kind: enum membership, finite numbers, ref target type, http(s)/data:image URLs only, size caps. Type definitions are cleaned to bounded plain data and unknown keys are dropped.

## What's built

Branch `idea/components`. Plugin `src/plugins/components/`:
- `model.ts`: schema types, cleaning/validation, titles, height estimate.
- `commands.ts`: `defineType`, `deleteType` (refused while cards use it), `addField`, `updateField`, `removeField` (clears values in the same undo step), `moveField`, `create`, `set`, `starter`.
- `starter.ts`: Persona, User story, Decision (ADR), Metric + 7 linked sample cards.
- `export.ts`: `exportJson`, `exportMarkdown`, ref edges, file export/import filters.
- `render.ts`, `editing.ts`, `index.ts`: cards, inline form editing, ref lines, right-click menus, Add-menu kit. Zoom detail levels: far = icon + big title, mid = `card` fields, near = everything.
- `panel.ts`: library panel (toolbar **Components**, key **C**): types list, no-code type editor, Library JSON editor, exports.
- `table.ts`: one type as a sortable, editable table.
- Tests in `commands.test.ts` (9): starter, add field updates every card + undo/redo, remove field + undo, validation, sanitizing, agent JSON flow, two-peer merge, .canvas round trip, exports. All 238 tests pass; typecheck clean.

## Demo

`cd ~/code/canvas-wt/components && pnpm exec vite --port 5214 --strictPort`, then open http://localhost:5214 (from another machine: `--host 127.0.0.1` and http://mini.internal:5214).
1. **New table**, select all (⌘A) + Delete to clear the cards. Then **Add… → Product discovery starter**: 2 personas, 3 stories, 1 decision, 1 metric. Dashed lines = references ("As a", "Serves").
2. Zoom out (⌘- or pinch): below 80% cards show summary fields only; below 45% only icon + big title.
3. Double-click a persona to get an inline form. Change Role and Tab to the next field: each field commits on its own and peers see it. **Done** or Esc closes the form. The open form can be taller than the card and overlap the card below until closed.
4. **Components** (or C) → Persona → **Edit**. In the add row: label "Experience", kind `enum`, options "Newcomer, Regular, Expert" → **Add field**. Both persona cards gain the field. Click the canvas (focus leaves the panel), then ⌘Z removes it; ⇧⌘Z brings it back. The toolbar Undo/Redo work too.
5. Right-click a story → **All User story cards as a table**. Change a Status or the "As a" dropdown; the card and its line update. Click a header to sort, **+ Row** adds a card, ◎ jumps to it.
6. Library panel → **Library JSON**. Add a type an agent wrote to the array, e.g. `{"id":"event","name":"Domain event","icon":"🟧","color":"#e8862a","fields":[{"label":"Event"},{"label":"Actor","kind":"ref","to":"persona","card":true}]}`, then **Apply**. Right-click the empty table → **New component ▸ Domain event**.
7. **Export all: Markdown / JSON** shows what an agent reads. **Save** writes the .canvas: library at the top level, refs as edges, Markdown text on each card.

Agent path from the console: `app.dispatch('components.create', { type: 'story', x: 0, y: 0, values: { want: 'Undo per player', status: 'Idea' } })`.

## Core / plugin API

What fit well:
- types and commands that return plain changes
- nested `x-` namespaces with per-field merge
- layout rules (derived height)
- import/export filters, menu providers, kits, `renderKey`
- `data-action`, so form controls don't start drags
- the view ignoring keys typed in inputs

What had to change (small):
- **New `meta` change op** (`src/core/doc.ts`, `src/core/store.ts`): `{ op: 'meta', key: 'x-plugin.entry', value }` writes document-level data. `meta` joined the undo scope, and `x-` objects in meta load as nested maps (per-entry merge). No other plugin wrote meta, and all old tests pass. This was the one real gap: plugins had no sanctioned place for doc-wide data.
- `src/main.ts`: registers the plugin and mounts the panel.

Rough edges found:
- Core doesn't render edges. The plugin draws its own SVG layer by reaching into `app.view.world`. Edge rendering, with plugin-supplied derived edges, belongs in core.
- No hook for view-only state like "editing this card". The plugin keeps a module-level Set and calls `app.view.render()`, the same pattern mats uses. Worth a small core API.
- Zoom detail levels are root CSS classes set from `viewport.onChange`. That works, but a `RenderCtx.zoom` / `lod` would let types render differently per level instead of hiding parts.
- Layout height is a char-count estimate. Real text measurement (or a DOM-reported size) would fit better. At mid zoom the box keeps its full height, which leaves empty space.

## Fit with the big vision

- **Multiplayer:** library and values are CRDT data. Tests show two peers adding fields to different types, and editing different fields of one card, merge cleanly. When two people change the schema of the same type at once, the last write wins for that whole type (could be made per field). Gap: on a canvas with no library yet, two peers defining their first types at the same moment each create the `x-components` map, and one peer's types are lost (the same create-the-submap race as core's per-node `x-` maps). Fix: create the namespace map up front, or store entries as flat keys.
- **Agent native:** the schema is the API. An agent reads `x-components` to learn the board's vocabulary, writes types as JSON, creates cards through validated commands, and reads Markdown/JSON back. Event storming, ADR logs and story maps are all types an agent can draft.
- **Local first / hosting:** everything is in the `.canvas` file, so git-tracked boards diff readably (values + derived Markdown). In Obsidian the cards still show as text + edges.
- **Marketplace security:** components are a **no-code tier below code plugins**. A shared "type pack" is pure data: no script, rendered via textContent, cleaned on input, bounded. That makes it safe to install from strangers, so it can sit on a lower-trust marketplace shelf than code plugins, which need sandboxing or review. Remaining risk: image URLs fetch from third-party hosts (IP leak, tracking pixel). A host could proxy or allow-list them, or allow only data: URLs in strict rooms.
- **Secrets / host model:** no secrets involved. A host could pin a team library as a policy (types read-only, values editable).

## Open questions

- Library per canvas, or a shared team library referenced by URL/version with upgrades? Probably both: importing a pack copies it into the canvas.
- Type migrations: when a field's kind changes, old values are kept but not shown. Do we need explicit conversions?
- Multi-value refs (story → several personas), computed fields (progress = current/target), conditional styling (color by status). How much declarative logic before it should be code?
- Should components and code plugins share one type registry, so a code plugin can add behavior to a component type?
- Templates beyond a field list: layout grid, badges, size presets.

## Effort to make it real

- Core edge rendering + view-state API + `zoom` in RenderCtx: 2–3 days.
- Real auto-size (measure), per-field schema merge, type migrations: 3–4 days.
- Pack import/export + versioning + marketplace listing for data-only packs: ~1 week.
- Polish (multi-refs, computed fields, keyboard nav in the table, image proxy): 1–2 weeks.
