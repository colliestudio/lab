import { Decision, Section, Steps, When } from "artifact";

export const page = {
  title: "Returns", group: "Journeys", order: 2, status: "todo" as const,
  summary: "How a customer sends something back, and who pays.", thumb: "evidence/returns.svg",
};

export default function Returns() {
  return (
    <>
      <Section id="flow" title="The flow">
        <Steps items={[{ title: "Request a return", body: "From the order page, within 30 days." }, { title: "Print a label", status: "doing" }, { title: "Refund", body: "Within 5 days of arrival." }]} />
      </Section>
      <Section id="refund" title="Refunds">
        <Decision id="d-refund" question="Who pays return shipping?" recommend={1} owner="Product" options={["The customer", "We do"]} />
        <When decision="d-refund" is="b">
          <Decision id="d-cap" question="Cap the free returns per customer?" owner="Product" options={["Yes, 3 a year", "No cap"]} recommend={0} />
        </When>
      </Section>
    </>
  );
}
