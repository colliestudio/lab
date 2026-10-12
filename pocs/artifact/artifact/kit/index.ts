// The kit: `import { Section, Table, Map, … } from "artifact"`.
export * from "./layout.tsx";
export * from "./decide.tsx";
export { Decision, When } from "./decision.tsx";
export { useAnswer, useAnswers, type Answer } from "./feedback.ts";
export { TimeAxis, type TimeEvent, type TimeBand } from "./timeaxis.tsx";
export { Table, Img, Compare, Chart, type Column, type CompareItem } from "./data.tsx";
export { Code, Diff } from "./code.tsx";
export { Map, type MapNodeIn, type MapEdgeIn } from "./map.tsx";
export { Flow } from "./flow.tsx";
export * from "./present.ts";
export { Replay } from "./replay.tsx";
export { useData, meta, imageSrc } from "./registry.ts";
export { useTheme } from "./theme.ts";
