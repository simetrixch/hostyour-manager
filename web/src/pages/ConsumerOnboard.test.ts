import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsumerOnboard } from "./ConsumerOnboard.tsx";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [search.params] }));
vi.mock("../api.ts", () => {
  const pending = () => new Promise(() => undefined);
  return { listOnboardTargets: pending, getChannelStages: pending, onboardConsumer: pending, prefillOnboard: pending, recordOwnerCredential: pending };
});

const render = (query: string): string => {
  search.params = new URLSearchParams(query);
  return renderToStaticMarkup(createElement(ConsumerOnboard));
};

describe("ConsumerOnboard as a consumer's Add stage", () => {
  it("carries the consumer's name, repository and stage, and preselects neither machine nor size", () => {
    const html = render("name=acme&repo=https%3A%2F%2Fgithub.com%2Fx%2Facme.git&stage=test&chartPath=deploy%2Fchart");
    expect(html).toContain("Add the test stage of acme");
    expect(html).toContain('value="https://github.com/x/acme.git"');
    expect(html).toContain('value="acme"');
    expect(html).toContain('<option value="" disabled="" selected="">Choose a size</option>');
    expect(html.match(/<option value="" disabled="" selected="">Loading…<\/option>/g)).toHaveLength(2);
    expect(html).toMatch(/<button type="submit" class="btn btn--primary" disabled="">/);
  });
  it("leaves a plain onboarding as it was: empty, at the default size", () => {
    const html = render("");
    expect(html).toContain("Onboard a consumer app");
    expect(html).toContain('<option value="small" selected="">small</option>');
  });
});
