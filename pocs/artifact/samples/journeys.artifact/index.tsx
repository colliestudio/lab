import { Callout, PageCards, Section, Stats, Link } from "artifact";

export default function Home() {
  return (
    <>
      <Stats items={[{ value: 3, label: "pages" }, { value: 2, label: "journeys" }, { value: 2, label: "decisions" }]} />
      <Section id="overview" title="Where each journey stands">
        <PageCards />
      </Section>
      <Section id="read" title="How to read this">
        <Callout tone="info">Use the left nav or the Previous / Next links. <b>Present</b> walks the current page; <b>Tour</b> walks all four in order. Details of the payment choice are in <Link to="checkout#payment">Checkout → Payment</Link>.</Callout>
      </Section>
    </>
  );
}
