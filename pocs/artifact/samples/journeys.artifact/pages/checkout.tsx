import { Card, Decision, Facts, Grid, Section, Status, Link } from "artifact";

export const page = {
  title: "Checkout", group: "Journeys", order: 1, status: "doing" as const,
  summary: "From cart to confirmation: where customers drop, and the one payment choice we owe.",
  thumb: "evidence/checkout.svg",
};

export default function Checkout() {
  return (
    <>
      <Section id="steps" title="The steps">
        <Grid cols={3}>
          <Card title="Cart" aside={<Status s="ok" />}>Works; the totals refresh on every edit.</Card>
          <Card title="Address" aside={<Status s="warn" />}>Autocomplete times out on slow mobile networks.</Card>
          <Card title="Payment" aside={<Status s="blocked" />}>One provider only; see the decision below.</Card>
        </Grid>
      </Section>
      <Section id="payment" title="Payment">
        <Facts items={[["providers", "1"], ["failure rate", "4.2%"], ["related", <Link key="l" to="limits#rate">the provider's rate limit</Link>]]} />
        <Decision id="d-pay" question="Add a second payment provider?" recommend={0} owner="Product" options={["Yes, add one", "No, tune the current one"]} why="A second provider halves the failures but doubles reconciliation work." />
      </Section>
    </>
  );
}
