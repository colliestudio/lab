// The kit: `import { Section, Table, Map, … } from "artifact"`.
export * from "./layout.tsx";
export * from "./decide.tsx";
export { Decision, When } from "./decision.tsx";
export { useAnswer, useAnswers, type Answer } from "./feedback.ts";
export { TimeAxis, type TimeEvent, type TimeBand } from "./timeaxis.tsx";
export { Link, PageCards } from "./pagenav.tsx";
export { usePages, useRoute, navigate, withTransition, duplicateTransitionNames, Morph, type PageEntry, type RouteState, type NavOpts, type TransitionOpts } from "./router.tsx";
export type { PageProps, PageMeta } from "./pages.ts";
export { Walkthrough, type WalkStep, type WalkScenario } from "./walkthrough.tsx";
export { Table, Img, Compare, Chart, type Column, type CompareItem } from "./data.tsx";
export { Code, Diff } from "./code.tsx";
export { Map, type MapNodeIn, type MapEdgeIn } from "./map.tsx";
export { Flow } from "./flow.tsx";
export * from "./present.ts";
export { openFeedback, download, startPresent, toggleTheme, usePresentControl } from "./host.ts";
export { Replay } from "./replay.tsx";
export { useData, meta, imageSrc } from "./registry.ts";
export { useTheme } from "./theme.ts";
