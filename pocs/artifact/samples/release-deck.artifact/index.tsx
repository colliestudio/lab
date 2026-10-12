// Slide 1 is the home route; the plan (deck/plan.ts) lists the rest and the frame (layout.tsx) is shared.
import { SlideView } from "./deck/Deck";

export const page = { title: "artifact kit 0.1", group: "Opening" };

export default function Home() { return <SlideView id="home" />; }
