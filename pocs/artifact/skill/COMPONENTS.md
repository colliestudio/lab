# artifact components (all from "artifact")

Reference for `skill/ARTIFACT.md`. One-line prop examples; ask the types (`artifact check` typechecks) for the rest.

## Layout
`<Page width="wide|full">` (or `"width"` in artifact.json) · `<Section id? title lead?>` (nest for sub-headings; clicking its heading folds it) · `<More label="Method">…</More>` quiet "▸ more" disclosure for skippable detail (`<Depth>` is a deprecated alias) · `<Stack row gap>` · `<Grid cols={3} | min="16rem">` · `<Card title aside tone href footer>` · `<CardGrid items={[{title, body, status, href}]}/>` · `<Lanes lanes={[{title, children}]}/>` · `<Tabs><Tab label="A">…</Tab></Tabs>` · `<Callout tone="info|success|warn|critical" title>`

## Status and facts
`<Badge tone>` · `<Status s="ok|done|merged|warn|risk|stale|blocked|failed|todo|open|planned|doing|review|info">` or `s={{label:"fix first", tone:"warn"}}` (also Gallery `status`, CardGrid, Timeline) · `<PR n title state="open|draft|merged|closed" checks="pass|fail|pending" stack={[2,3]} href conflict updatedAt asOf review />` (fits Table cells) · `<Stale says="3 open" now="1 open" asOf />` · `<Source label href kind="pr|thread|commit|file|doc" from="provenance" inline />` · `<Ago iso asOf />` · `<Time iso />` (absolute, in artifact.json `timeZone`) · `<Stats items={[{value, label, tone, href, sub}]}/>` · `<Facts items={[["main","ok"]]}/>`

## Reading flow and decisions
`<Steps items={[{title, body, status}]}/>` · `<Questions items={["q" | {q, why, options, owner}]} start/>` · `<Checklist items={["x" | {text, done, note, status}]}/>` · `<Actions items={[{title, why, effort, rec, owner, tone, status, sources}]}/>` ranked do-first list · `<Scorecard options rows={[{name, weight, cells:[{grade:"best|ok|weak|bad|na", text}]}]} recommend verdict/>` (alias `Matrix`) · `<RiskMatrix risks={[{id,title,like:"low|med|high",impact,mitigation}]}/>` · `<Stages stages={[{title, sub, tone}]} rows={[{label, cells}]}/>` (alias `Progression`)

`<Decision id question options={[{label, note, key?}]} recommend={0} owner why source/>`: **the reader can answer it** (an option, their own, or "not sure / discuss", plus a note). `<DecisionIndex/>` lists decisions with answers. `<When decision="d1" is="a|label|other|unsure" not answered unanswered>…</When>` shows content by answer; follow-up Decisions inside make a decision tree. `useAnswers()` reads answers.

## Time
`<Timeline items={[{when, title, body, status, lane?, group?}]} bucket="hour|10min|day|minutes" compact/>` (with `lane`: swimlane grid; same `when` shares a row) · `<TimeAxis title lead events={[{at, to?, label, lane?, tone?}]} bands={[{from,to,label,tone}]} segments={[{from,to,weight,label}]}/>` real time axis (`segments` break the axis for 6 weeks then 36 hours; zone = `timeZone`)

## Data
`<Table columns={["name", {key, label, render, align, sort}]} rows collapsed/>` (sortable; a row `href` links the first cell) · `<Chart data={[{label,value,tone}]} kind="bar|line" unit/>` or `series={[{name, points}]}` · `<Compare items={[{label, src|node, caption}]} caption/>` · `<Img src caption fit="cover|contain" height thumb zoom={false}/>` (click = lightbox; `imageSrc(path)` for your own `<img>`) · `<Gallery items/>`: variants `{label, src|node, aside, caption}` one at a time, or `layout="tiles"` with `{label, thumb, status, summary, badges, detail}` (click opens `detail` below; each item is a present step)

## Technical
`<Map nodes={[{id,label,group?,state?,note?,href?,section?}]} edges groups direction height/>` (fits its column, Fit/100%/±/drag; click focuses; about 10 nodes; 1.5 MB ELK; `check` warns under 65%) · `<Diff patch="evidence/x.patch" file="src/a.ts" hunks="1,3" notes={{12:"why", "text":"or by text"}} wrap collapsed/>` (give `file` as a literal so the patch is pruned) · `<Code file="evidence/a.ts" ranges="1-10,40-52" highlight="4" notes path href collapsed/>` or `code={str}` · `<Replay src="evidence/x.replay" steps={[2,3]} caption collapsed/>` (~120 KB) · `<Flow chart={"sequenceDiagram\n…"} collapsed/>` Mermaid (~3 MB: prefer Map; sequence/flow/state/ER/gantt/pie only). `collapsed` makes a heavy block a one-line stub that opens on click; the default is open.

## Pages
`pages/<id>.tsx`: `export default` the page, `export const page = {title, group, order, summary, status, icon, thumb}` (status = a Status key or `{label, tone}`; `thumb` an evidence image). `index.tsx` is home. `<PageCards group? ids? cols?/>` cards linking to pages (title, summary, status, thumb) · `<Link to="journey-2#fix">label</Link>` (`to="#fix"` = this page) · artifact.json `"tour": ["home","a","b"]`. Page ids are file names; "home" is reserved. A Section id is unique per page, not across pages.

## Walkthrough
`<Walkthrough scenarios={[{label, steps:[{title, when, who, body, tone:"bad|good|warn", state, visual, note}]}]} states={["A","B"]} visual={(step,i,scenario)=>node}/>`: scenarios as tabs, steps on the left, the step's visual + text on the right, an optional state rail. ↑/↓ steps, ←/→ scenarios; each step is a present step.

## Present mode (custom components)
`<Step>` reveals one by one. `usePresent()` gives `{active, slide, step, steps}`; `usePresentStep()` is the step (-1 when not presenting). `const {step, setStep, active, markers} = usePresentSteps(n, initial)`: render `markers` once; `step` is 0..n (your selection when not presenting); `setStep(k)` also moves the slide's counter, so clicks and → / Space stay in sync. Space/Enter step the slide unless the focus is on a decision option, a link or a disclosure summary.

## Data and helpers
`useData("name")` reads data/name.json · `meta` is artifact.json · `useTheme()` is "light"|"dark".
