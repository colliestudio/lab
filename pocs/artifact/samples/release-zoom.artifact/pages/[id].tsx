// One module, every route: the 26 features come from data/release.json, plus the two edges of the map.
import type { PageProps } from "artifact";
import { ORDER } from "../model.ts";
import { FeaturePage, NextPage, RemovedPage } from "../Zoomed.tsx";

export const pages = (data: Record<string, any>) => [
  ...data.release.features.map((f: any) => ({
    id: f.id, title: f.title, group: data.release.themes.find((t: any) => t.id === f.theme).title, order: ORDER().indexOf(f.id) + 1, summary: f.oneLiner,
  })),
  { id: "removed", title: "Left behind", group: "Edges of the map", order: 90, summary: "What v0.1 tried and dropped." },
  { id: "next", title: "Next up", group: "Edges of the map", order: 91, summary: "After v0.1, and one question for you." },
];

export default function Place({ id }: PageProps) {
  return id === "removed" ? <RemovedPage /> : id === "next" ? <NextPage /> : <FeaturePage id={id} />;
}
