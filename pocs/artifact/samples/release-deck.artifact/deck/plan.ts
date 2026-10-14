// generated: the slide plan (one page per slide)
export interface SlideSpec { id: string; group: string; kind: "title" | "numbers" | "cover" | "feature" | "cli" | "cut" | "next" | "call"; head: string; order: number; theme?: string; feature?: string; features?: string[]; num?: number; items?: string[]; steps?: number; wide?: boolean }
export const SLIDES: SlideSpec[] = [
 {
  "id": "home",
  "group": "Opening",
  "kind": "title",
  "head": "Agents write the page.",
  "order": 0
 },
 {
  "id": "numbers",
  "group": "Opening",
  "kind": "numbers",
  "head": "Thirteen rounds, two days.",
  "order": 1
 },
 {
  "id": "ch-authoring",
  "group": "Write the page",
  "kind": "cover",
  "head": "Write the page",
  "theme": "authoring",
  "num": 1,
  "items": [
   "artifact-dir",
   "data-evidence",
   "status-blocks",
   "present-hooks"
  ],
  "order": 2
 },
 {
  "id": "artifact-dir",
  "group": "Write the page",
  "kind": "feature",
  "head": "A folder, not a format.",
  "theme": "authoring",
  "feature": "artifact-dir",
  "order": 3
 },
 {
  "id": "data-evidence",
  "group": "Write the page",
  "kind": "feature",
  "head": "Proof travels inside the file.",
  "theme": "authoring",
  "feature": "data-evidence",
  "order": 4
 },
 {
  "id": "status-blocks",
  "group": "Write the page",
  "kind": "feature",
  "head": "Status at a glance.",
  "theme": "authoring",
  "feature": "status-blocks",
  "order": 5
 },
 {
  "id": "present-hooks",
  "group": "Write the page",
  "kind": "feature",
  "head": "Your component keeps the beat.",
  "theme": "authoring",
  "steps": 4,
  "feature": "present-hooks",
  "order": 6
 },
 {
  "id": "ch-reading",
  "group": "Read and present",
  "kind": "cover",
  "head": "Read and present",
  "theme": "reading",
  "num": 2,
  "items": [
   "present-mode",
   "compact-header",
   "folding-more",
   "download",
   "gallery"
  ],
  "order": 7
 },
 {
  "id": "present-mode",
  "group": "Read and present",
  "kind": "feature",
  "head": "Every page is a talk.",
  "theme": "reading",
  "feature": "present-mode",
  "order": 8
 },
 {
  "id": "compact-header",
  "group": "Read and present",
  "kind": "feature",
  "head": "Headers that step aside.",
  "theme": "reading",
  "feature": "compact-header",
  "order": 9
 },
 {
  "id": "folding-more",
  "group": "Read and present",
  "kind": "feature",
  "head": "Fold what can wait.",
  "theme": "reading",
  "feature": "folding-more",
  "order": 10
 },
 {
  "id": "download",
  "group": "Read and present",
  "kind": "feature",
  "head": "One file. Pass it on.",
  "theme": "reading",
  "feature": "download",
  "order": 11
 },
 {
  "id": "gallery",
  "group": "Read and present",
  "kind": "feature",
  "head": "Sixteen branches, one grid.",
  "theme": "reading",
  "feature": "gallery",
  "order": 12
 },
 {
  "id": "ch-decisions",
  "group": "Decide and give feedback",
  "kind": "cover",
  "head": "Decide and give feedback",
  "theme": "decisions",
  "num": 3,
  "items": [
   "decision-walk",
   "feedback-drawer",
   "scorecard"
  ],
  "order": 13
 },
 {
  "id": "decision-walk",
  "group": "Decide and give feedback",
  "kind": "feature",
  "head": "Answer on the page.",
  "theme": "decisions",
  "feature": "decision-walk",
  "order": 14
 },
 {
  "id": "feedback-drawer",
  "group": "Decide and give feedback",
  "kind": "feature",
  "head": "One paste back to the agent.",
  "theme": "decisions",
  "feature": "feedback-drawer",
  "order": 15
 },
 {
  "id": "scorecard",
  "group": "Decide and give feedback",
  "kind": "feature",
  "head": "Compare without a spreadsheet.",
  "theme": "decisions",
  "wide": true,
  "feature": "scorecard",
  "order": 16
 },
 {
  "id": "ch-technical",
  "group": "Show the evidence",
  "kind": "cover",
  "head": "Show the evidence",
  "theme": "technical",
  "num": 4,
  "items": [
   "map-fit",
   "code-notes",
   "timeaxis",
   "timeline-lanes",
   "walkthrough",
   "stages"
  ],
  "order": 17
 },
 {
  "id": "map-fit",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "Maps that fit.",
  "theme": "technical",
  "wide": true,
  "feature": "map-fit",
  "order": 18
 },
 {
  "id": "code-notes",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "Real diffs, with notes.",
  "theme": "technical",
  "feature": "code-notes",
  "order": 19
 },
 {
  "id": "timeaxis",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "Time on a real scale.",
  "theme": "technical",
  "wide": true,
  "feature": "timeaxis",
  "order": 20
 },
 {
  "id": "timeline-lanes",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "Lanes that pack.",
  "theme": "technical",
  "feature": "timeline-lanes",
  "order": 21
 },
 {
  "id": "walkthrough",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "One case, step by step.",
  "theme": "technical",
  "wide": true,
  "feature": "walkthrough",
  "order": 22
 },
 {
  "id": "stages",
  "group": "Show the evidence",
  "kind": "feature",
  "head": "Stage by stage.",
  "theme": "technical",
  "wide": true,
  "feature": "stages",
  "order": 23
 },
 {
  "id": "ch-cli",
  "group": "CLI and evidence",
  "kind": "cover",
  "head": "CLI and evidence",
  "theme": "cli",
  "num": 5,
  "items": [
   "cli"
  ],
  "order": 24
 },
 {
  "id": "cli",
  "group": "CLI and evidence",
  "kind": "cli",
  "head": "Write. Check. Look. Build.",
  "theme": "cli",
  "steps": 5,
  "features": [
   "cli-core",
   "check-advice",
   "shot",
   "capture",
   "gather",
   "evidence-safety"
  ],
  "order": 25
 },
 {
  "id": "ch-multipage",
  "group": "Multi-page",
  "kind": "cover",
  "head": "Multi-page",
  "theme": "multipage",
  "num": 6,
  "items": [
   "pages",
   "tour"
  ],
  "order": 26
 },
 {
  "id": "pages",
  "group": "Multi-page",
  "kind": "feature",
  "head": "Pages, in one file.",
  "theme": "multipage",
  "feature": "pages",
  "order": 27
 },
 {
  "id": "tour",
  "group": "Multi-page",
  "kind": "feature",
  "head": "A tour, in your order.",
  "theme": "multipage",
  "feature": "tour",
  "order": 28
 },
 {
  "id": "cut",
  "group": "Closing",
  "kind": "cut",
  "head": "What we cut.",
  "order": 29
 },
 {
  "id": "next",
  "group": "Closing",
  "kind": "next",
  "head": "What's next.",
  "order": 30
 },
 {
  "id": "call",
  "group": "Closing",
  "kind": "call",
  "head": "Your call.",
  "order": 31
 }
];

/** Route metadata per slide (nav title, group, order). */
export const PAGES: { id: string; title: string; group: string; order: number; summary?: string }[] = [
 {
  "order": -1,
  "id": "home",
  "title": "artifact kit 0.1",
  "group": "Opening"
 },
 {
  "id": "artifact-dir",
  "title": "A folder, not a format",
  "group": "Write the page",
  "order": 3,
  "summary": "Artifacts are directories the agent writes"
 },
 {
  "id": "call",
  "title": "Your call",
  "group": "Closing",
  "order": 31
 },
 {
  "id": "ch-authoring",
  "title": "Write the page",
  "group": "Write the page",
  "order": 2,
  "summary": "An artifact is a directory: TSX (or MDX), data and evidence. The agent picks the structure."
 },
 {
  "id": "ch-cli",
  "title": "CLI and evidence",
  "group": "CLI and evidence",
  "order": 24,
  "summary": "new, dev, check, build, plus shot, capture and gather so agents can collect data and look at their own output."
 },
 {
  "id": "ch-decisions",
  "title": "Decide and give feedback",
  "group": "Decide and give feedback",
  "order": 13,
  "summary": "Readers answer decisions on the page, leave comments, and copy it all back to the agent in one paste."
 },
 {
  "id": "ch-multipage",
  "title": "Multi-page",
  "group": "Multi-page",
  "order": 26,
  "summary": "Several pages in the same single HTML: hash routes, grouped nav, page cards and a tour."
 },
 {
  "id": "ch-reading",
  "title": "Read and present",
  "group": "Read and present",
  "order": 7,
  "summary": "The host wraps every page with an outline, present mode, folding and a one-file download."
 },
 {
  "id": "ch-technical",
  "title": "Show the evidence",
  "group": "Show the evidence",
  "order": 17,
  "summary": "Maps, real diffs, code with notes, time axes and step-by-step walks instead of prose."
 },
 {
  "id": "cli",
  "title": "Write. Check. Look. Build",
  "group": "CLI and evidence",
  "order": 25
 },
 {
  "id": "code-notes",
  "title": "Real diffs, with notes",
  "group": "Show the evidence",
  "order": 19,
  "summary": "Code and diffs with notes"
 },
 {
  "id": "compact-header",
  "title": "Headers that step aside",
  "group": "Read and present",
  "order": 9,
  "summary": "Compact header, sources behind one button"
 },
 {
  "id": "cut",
  "title": "What we cut",
  "group": "Closing",
  "order": 29
 },
 {
  "id": "data-evidence",
  "title": "Proof travels inside the file",
  "group": "Write the page",
  "order": 4,
  "summary": "Data and evidence inlined at build"
 },
 {
  "id": "decision-walk",
  "title": "Answer on the page",
  "group": "Decide and give feedback",
  "order": 14,
  "summary": "Decision walk: answer on the page"
 },
 {
  "id": "download",
  "title": "One file. Pass it on",
  "group": "Read and present",
  "order": 11,
  "summary": "Download the same single file"
 },
 {
  "id": "feedback-drawer",
  "title": "One paste back to the agent",
  "group": "Decide and give feedback",
  "order": 15,
  "summary": "One Feedback drawer"
 },
 {
  "id": "folding-more",
  "title": "Fold what can wait",
  "group": "Read and present",
  "order": 10,
  "summary": "Quiet folding and <More>"
 },
 {
  "id": "gallery",
  "title": "Sixteen branches, one grid",
  "group": "Read and present",
  "order": 12,
  "summary": "Gallery: tiles with drill-down, variants, lightbox"
 },
 {
  "id": "map-fit",
  "title": "Maps that fit",
  "group": "Show the evidence",
  "order": 18,
  "summary": "Map fits its column"
 },
 {
  "id": "next",
  "title": "What's next",
  "group": "Closing",
  "order": 30
 },
 {
  "id": "numbers",
  "title": "Thirteen rounds, two days",
  "group": "Opening",
  "order": 1
 },
 {
  "id": "pages",
  "title": "Pages, in one file",
  "group": "Multi-page",
  "order": 27,
  "summary": "Multi-page artifacts"
 },
 {
  "id": "present-hooks",
  "title": "Your component keeps the beat",
  "group": "Write the page",
  "order": 6,
  "summary": "Present steps for custom components"
 },
 {
  "id": "present-mode",
  "title": "Every page is a talk",
  "group": "Read and present",
  "order": 8,
  "summary": "Present mode"
 },
 {
  "id": "scorecard",
  "title": "Compare without a spreadsheet",
  "group": "Decide and give feedback",
  "order": 16,
  "summary": "Scorecard and RiskMatrix"
 },
 {
  "id": "stages",
  "title": "Stage by stage",
  "group": "Show the evidence",
  "order": 23,
  "summary": "Stages: compare a few states row by row"
 },
 {
  "id": "status-blocks",
  "title": "Status at a glance",
  "group": "Write the page",
  "order": 5,
  "summary": "Status building blocks: Stats, Actions, Facts, PR, Ago"
 },
 {
  "id": "timeaxis",
  "title": "Time on a real scale",
  "group": "Show the evidence",
  "order": 20,
  "summary": "TimeAxis: a real time scale"
 },
 {
  "id": "timeline-lanes",
  "title": "Lanes that pack",
  "group": "Show the evidence",
  "order": 21,
  "summary": "Timeline swimlanes that pack"
 },
 {
  "id": "tour",
  "title": "A tour, in your order",
  "group": "Multi-page",
  "order": 28,
  "summary": "Tour across pages"
 },
 {
  "id": "walkthrough",
  "title": "One case, step by step",
  "group": "Show the evidence",
  "order": 22,
  "summary": "Walkthrough: one case, step by step"
 }
];
