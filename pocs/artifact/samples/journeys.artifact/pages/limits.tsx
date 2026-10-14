import { Callout, Section, Table } from "artifact";

export const page = { title: "Limits", group: "Reference", order: 3, summary: "Hard limits of the systems the journeys depend on." };

export default function Limits() {
  return (
    <Section id="rate" title="Provider rate limit">
      <Callout tone="warn">The payment provider allows 50 requests per second; peak is 35.</Callout>
      <Table columns={["system", "limit", "peak"]} rows={[{ system: "payments", limit: "50 rps", peak: "35 rps" }, { system: "labels", limit: "10 rps", peak: "2 rps" }]} />
    </Section>
  );
}
