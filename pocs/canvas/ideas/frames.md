# frames: navigation and structure for big canvases

Branch `idea/frames` (merge-ready as `task-3.14-frames`), port 5219.

**Portals are off by default.** Turn them on with `?portals=1` (remembered in this browser, so rooms entered through a portal keep it; `?portals=0` turns them off). Frames, outline, minimap, keys, present and follow always ship on. Why: a portal joins the other room as a full peer, so read-only and "a room you can't see" need the host (see Implications). The portal code, its tests and the demo stay; with the flag off a `.canvas` file node is an ordinary file node, the outline and minimap don't list portals, the "Portal to another room" kit is absent, and the demo has no portal.

## Idea

Frames turn a big canvas into named places: a frame is a titled region whose contents move with it, listed in an outline with a minimap, reachable by keys, and playable as slides with peers following the presenter. A portal is a node that shows another room live inside this one (read-only), and double-clicking it takes you into that room with a breadcrumb back.

## How it works

- **Frame** = JSON Canvas `group` (label = title). `x-frame` holds what the spec has no field for: `order` (slide position) and `skip` (left out of the slides). A plain group with no `x-` fields (an Obsidian group) is a frame too. Other plugins' groups (decks, kanban boards) are not.
- **Membership is geometry**, as in JSON Canvas: a node whose center is inside a frame rides on it (core rider rule), the innermost frame if they nest. Frames register their rider rule last, so a piece rides its board and the board rides the frame. Riders move and come to front with the frame; Delete takes them along (menu: "Remove frame, keep contents").
- **No snowplow**: while a pointer is down, membership is frozen as it was at the press, so a frame dragged over loose objects passes them by; geometry decides again on release (drop it over something and it's in). `Store.invalidate()` (new) rebuilds the snapshot when the freeze ends.
- **Frames are backdrops**: created below everything; only the title bar and resize corner take the pointer, the body passes clicks to what's under it (or the table, for box select). Pressing a frame raises it with its contents (core `raise`), so `frames.sink` puts frames back under every other node right after the press and on release (not undoable, keeps their order among themselves). Without it a dragged frame covered unrelated notes.
- **Order**: explicit `order` first, then reading order (rows, then left to right). Slide order is written down (`frames.pin`, every frame gets its current place) the moment a frame can move: pressing a frame title or any press while a frame is selected, arrow keys on a selected frame, creating a frame (the new one goes last) and starting a presentation. After that, dragging a frame never reorders the talk; reordering is the outline's ↑↓ or the menu. Plain groups nobody touched (an Obsidian vault) stay in reading order, and cost no writes until someone presses a frame. Chosen over "pin only on first present" because the outline shows slide numbers all the time, so a drag before any present already reshuffled what you could see. Commands: `frames.create` (around ids or a box), `rename`, `resize`, `reorder`, `skip`, `unframe`, `createPortal`, `retarget`.
- **Navigation**: `1`–`9` go to frame N, `[` `]` previous/next (relative to the frame the camera is on), `⇧F` frames the selection, `O` folds the outline. Camera moves are animated (zoom geometric, ease in/out) and keep clear of the toolbar and outline (insets).
- **Outline panel** (top right): frames in order with slide numbers, object counts and the portals inside each; click = fly there, double-click = rename/enter, ↑↓ = reorder. Minimap of the whole canvas with the view rectangle; click/drag moves the view.
- **Present** (`⌘↵`, ▶ Present, or a frame's menu "Present from here"): full screen, UI hidden, one slide per frame (skipped frames left out), ←/→/Space/PageUp/Down/Home/End, Esc ends. Deleting the current frame mid-talk moves to the slide that took its place (or the last one).
- **Follow the presenter**: the presenter's awareness carries `present: {frame, index, count, title}` (ephemeral, never in the doc). Peers get a banner "Carol is presenting · 2/3 · Sprint board [Follow]"; following flies their camera on every slide change; taking the camera (drag/wheel) stops following; the banner goes when the presentation ends. Peer states are validated before use.
- **Portal** (behind `?portals=1`) = JSON Canvas `file` node pointing at `<room>.canvas` (the same shape as Obsidian Advanced Canvas portals), `x-portal.room` naming the live room (without it, the file's base name is the room).
  - **Loading**: one `Y.Doc` per portal room (shared by all portals into it, refcounted, closed 2 s after the last one goes), loaded from this device's copy (`y-indexeddb`, the room's own DB name) and kept live by a second `y-webrtc` provider into that room with no awareness state (invisible, not a player). Same-browser tabs sync over BroadcastChannel with no server.
  - **Reading**: a `Store` over that doc borrows the app's containment/rider/layout rules (`Store.adoptViewRules`, new core API), and the portal draws it with the app's own `ObjectType.render`ers, scaled to fit. Renderers get `ctx.viewer` = me, so another room's private hands stay private. Read-only: nothing dispatches into the other doc, no repairs or migrations run on it.
  - **Budget**: a portal under 220 px wide on screen, or beyond the 3 largest on screen, draws a snapshot (one SVG rect per object); off-screen portals draw nothing. The doc keeps syncing in all modes (cheap); only DOM work stops. A portal inside a portal is a label (one level deep).
  - **Entering**: double-click (or Enter ↗) navigates to `?room=<id>&via=<trail>`. The trail (`~` = the solo table) rides in the URL, so reload and shared links keep the breadcrumb; entering a room already on the trail goes back to it. The saved camera is now per room (it was one key for all rooms, so an entered room opened at the old table's camera).
  - A portal into the room you're in shows a note instead of itself (and y-webrtc can't open one room twice in a page).

## What's built

- `src/plugins/frames/`: `model.ts` (frame/portal model, membership, order, `outline()`), `commands.ts`, `camera.ts` (fit with insets, interpolation, `flyTo`), `portals.ts` (`PortalRooms`, `PortalViews`), `outline.ts`, `present.ts` (`Presenter`, `attachFollow`, `presentersIn`), `nav.ts` (trail, breadcrumb), `demo.ts`, `frames.css`, `index.ts`.
- Core: `Store.adoptViewRules(from)`, `Store.invalidate()` (+2 core tests).
- Shell (`main.ts`): plugin registered last, breadcrumb in the toolbar, follow attached on room join, per-room camera key.
- Tests: 20 unit (model, commands incl. chess-in-frame, JSON Canvas round trip, freeze, camera, nav, awareness validation, portal rooms live + refcount, pin, sink) + 9 DOM (portals on/off, live/snapshot/off modes with the chess renderers, self-portal, enter, order pinned on press / arrow key / present, present stepping). 259 total pass, typecheck and build clean.
- Headless Chrome e2e (Playwright `channel: 'chrome'`, scripts not committed; re-run for the merge on 5287 + own signaling 5289): flag off by default (no portal kit/element/outline rows), a frame dragged past the others keeps its slide number, the frame menu has one Delete, `?portals=1` shows the live portal and it follows a move in the room's tab, the flag survives entering a room, `?portals=0` turns it off, follow-the-presenter across two browser contexts over signaling. No page errors. Earlier (before the merge work, `/tmp/frames-e2e`): demo seed, outline, key jumps, frame drag carries contents, frame dragged over a loose note leaves it, portal live/snapshot, a move in the chess room's tab shows in the index portal, double-click enter + breadcrumb back, follow-the-presenter across two browser contexts over the real signaling (5192). No page errors.

## Demo

Portal steps (2 portal part, 4–6) need `?portals=1`.

1. Open `http://mini.internal:5219/?portals=1`.
2. Add… → **Frames demo: 3 frames + a portal into a chess room** (without the flag: **Frames demo: 3 frames**). It lands right of what's on the table and seeds the room `frames-demo-chess` on this device.
3. Press `1`, `2`, `3` or `[` `]`; click rows in the outline; drag in the minimap.
4. Zoom out (`0`): the portal turns into a snapshot; zoom in and it's live again.
5. Open `http://mini.internal:5219/?room=frames-demo-chess` in a second tab and move a piece: the portal in the first tab follows.
6. Double-click the portal: you're in the chess room, breadcrumb "My table › frames-demo-chess" top left; click "My table" to go back.
7. `⌘↵` (or ▶ Present): → / Space to step, Esc to end. Frame menu (right-click the title): "In the presentation", "Earlier/Later in order".
8. Follow: Share the table into a room, open the room link in another browser (or a private window), present in one, click Follow in the other.

## What it says about core / the plugin API

- **Reading a second doc is cheap once rules can be shared.** `adoptViewRules` + the existing pure renderers were enough to draw another room with every plugin's look. Renderers that only use `ctx` (not `app`) made this possible; a render API that reached into `app` would have needed a second `App`. Keep renderers ctx-only.
- **A second `App` is not an option today**: `View` listens on `window` (keys) and plugins mount DOM in `setup` (chess palette, cards key handlers). An "embedded, input-less view" mode would be the core change if portals ever need interaction.
- **Rider rules need policy.** Frames reuse riders, but riders are all-or-nothing: Delete takes them along (fine for a board's pieces, debatable for a frame), and there's no "this rule is geometric, freeze it during a gesture" hook. The freeze here is a module-level flag driven by pointer events + `invalidate()`. A core gesture lifecycle (`onGestureStart/End`) or a per-rule `stableDuringDrag` flag would replace it. The rule order (frames last) is also implicit.
- **Z-order has no "backdrop" notion.** Frames are created at the lowest z and pass pointer events through their body; raising a frame (title click) still lifts it above unrelated nodes. A core layer/band (backdrop, normal, overlay) would fix this cleanly.
- **Presence needs a generic field API.** Follow uses `presence.awareness.setLocalStateField('present', …)` and reads raw states; `Presence` only knows cursor/sel/held. Prototype hit the same thing (follow the presenter). Proposal: `presence.set(ns, value)` / `presence.on(ns, fn)` with per-plugin namespaces.
- **Plugins don't know when presence appears** (it's set after `use()` when a room is joined), so `main.ts` calls `attachFollow`. An `app.onPresence(fn)` hook would remove that.
- **Camera API**: `flyTo`, insets and "which frame am I on" live in the plugin; a core `viewport.animateTo` plus registered screen insets (panels) would let every plugin (search results, "go to log entry") reuse it.
- **Keys**: `1`–`9`, `[`, `]`, `O`, `⇧F` were free; the one-binding-per-key map is a risk as more plugins want digits. Same finding as eventstorm.
- **Agents**: `outline(doc)` is pure and gives an agent a table of contents (frames in order with rects, counts, portals and their rooms); `frames.*` commands are plain data; `app.frames.go(id)` moves the camera (for the screenshot half of "screenshot + JSON"). An agent can lay out a deck: create frames around groups, `reorder`, then present.

## Fit with the vision

- **Expandable canvas**: frames + outline + minimap are what makes a big canvas navigable; portals let a space grow as linked rooms instead of one huge doc (one canvas per sprint, an index linking them). Matches AFFiNE frames-as-slides, Obsidian Advanced Canvas portals/presentation, Muse nested boards.
- **Local first / JSON Canvas**: frames are plain groups, portals plain `file` nodes to `.canvas` files. An Obsidian vault of canvases opens with working frames, and its portals map 1:1 to rooms by file name.
- **Multiplayer**: follow-the-presenter over awareness, no doc writes; portals sync each room independently.
- **Work & play**: the demo puts a team agenda and a game table side by side; game rooms embedded in a team space work today.

## Implications

- **Permissions**: a portal opens the other room as a full peer (the whole Y.Doc comes down; read-only is only this client's discipline, and the sync still sends up whatever this device's IndexedDB copy of that room has that the peers don't). With access control, a portal into a room you can't read must get nothing: the provider/host refuses, and the portal shows "nothing here, or not a room you can see" (what it shows today after 4 s of emptiness). Read-only access should be enforced by the host (reject updates from read-only peers), not by the portal. Also: a portal is a link others click, so it should never grant access by itself; and a room's file name is guessable, so room ids for private rooms must be unguessable.
- **Host model** (one host per room): portals cross hosts. The index room's host doesn't serve the chess room; the portal connects to the chess room's own host (or mesh). With many portals that's many connections per tab: the budget should also cap open connections (today all portals' rooms stay connected; only rendering is budgeted), and a host could serve snapshots (a small JSON/PNG at a URL) for portals far away, upgrading to live when big on screen. A room on a host you're offline from shows the last local copy.
- **Agents**: frames are an agent's map (outline, go to frame, "what's in frame 2"); a portal is a pointer an agent can follow to another room's doc. An agent working through the bridge could open portal rooms the same way (`PortalRooms` is DOM-free).

## Open questions

- Delete of a frame: take the contents (current, like Figma) or keep them (like Obsidian)? The menu offers both.
- Membership by center vs full containment: center is forgiving but a big node half outside belongs to the frame.
- Portal interaction: read-only now. Interactive portals (move a piece without entering) would need a second `View` with input scoped to the portal box, and permissions to write.
- Portal auto-connect: every portal room is joined on sight. Should far-away portals connect at all, or only show the last local copy until zoomed in?
- `presence.awareness.setLocalStateField('present', …)` writes outside `Presence`'s own fields; fine for a POC, wants the generic presence API.
- The chess demo room is seeded per device; on a second device the portal shows the room only if a peer that has it is online.

## Known gaps (deferred on purpose)

- **A portal uploads this device's copy of the other room** (can merge diverged copies into it) and **every portal room stays connected** (only rendering is budgeted). Both need the host (read-only peers, refused rooms, a connection cap); portals stay off until then.
- **Portal chess/interaction through a portal** (Alex asked: two people playing through a portal): read-only today; needs a second `View` with scoped input and host-enforced write access. Not built.
- **Portal previews** (ideas from Alex's review chat, not decided, not built): a plugin `preview(doc)` hook per type, presence plus the last log line on the portal, a portal that targets a frame instead of the whole room, an activity cue, hover peek, host-served snapshots for far-away portals.
- Frame membership by center vs full containment, presence API, gesture lifecycle and z bands: core work listed above; the freeze flag and `frames.sink` stand in for the last two.
- Membership of a frame that nobody pressed in a vault with several plain groups: slide order stays reading order until the first press, present or new frame.
- Touch: no long-press/drag handling beyond what core gives.

## Effort

- Built: about a day of work (plugin ~2.3k lines incl. CSS and tests, 2 small core methods).
- To merge into poc: small. No core conflicts expected beyond `store.ts` (two added methods) and `main.ts` (four lines).
- Production-quality: frames + outline + present ~2–3 days more (core backdrop layer, gesture hooks, presence API, help/keys listing, touch). Portals ~1 week more with permissions, host-served snapshots, connection budget, and interactive portals.
