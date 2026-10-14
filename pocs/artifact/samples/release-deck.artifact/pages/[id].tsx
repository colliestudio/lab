// One module, every slide: the plan lists them; the frame lives in layout.tsx and stays mounted.
import type { PageProps } from "artifact";
import { PAGES } from "../deck/plan";
import { SlideView } from "../deck/Deck";

export const pages = () => PAGES.filter((p) => p.id !== "home");

export default function SlidePage({ id }: PageProps) { return <SlideView id={id} />; }
