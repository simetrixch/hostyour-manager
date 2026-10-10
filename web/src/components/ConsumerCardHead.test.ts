import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsumerView } from "../api.ts";
import { groupEnvironments } from "../tenantRows.ts";
import { ConsumerCardHead } from "./ConsumerCardHead.tsx";

vi.mock("react-router", () => ({ Link: ({ to, children, className }: { to: string; children: import("react").ReactNode; className?: string }) => createElement("a", { href: to, className }, children) }));

const row = (id: string, stage: ConsumerView["stage"], domain: string): ConsumerView =>
  ({ id, name: "acme", stage, status: "active", domain, repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", modified: 0 } as ConsumerView);

describe("ConsumerCardHead", () => {
  it("shows a consumer once with its stages, and offers + add onboarding at the stage it does not stand at", () => {
    const prod = row("app_p", "prod", "apps2.example");
    const [group] = groupEnvironments([prod, row("app_d", "dev", "apps1.example")], (r) => r.name);
    const html = renderToStaticMarkup(createElement(ConsumerCardHead, { group: group!, selected: prod, onSelect: () => undefined }));
    expect(html.match(/servercard__name/g)).toHaveLength(1);
    expect(html).toMatch(/PROD.*apps2\.example/);
    expect(html).toMatch(/DEV.*apps1\.example/);
    expect(html).toContain('href="/consumers/onboard?name=acme&amp;repo=https%3A%2F%2Fgithub.com%2Fx%2Facme.git&amp;stage=test&amp;chartPath=deploy%2Fchart"');
    expect(html).toContain("Actions for PROD · apps2.example");
  });
});
