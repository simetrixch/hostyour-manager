import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TenantView } from "../api.ts";
import { TenantStageActions } from "./TenantStageActions.tsx";

// Render the real selector after its existing asynchronous inventory load, without a browser.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
const api = vi.hoisted(() => ({ listTenants: vi.fn(), listTenantTargets: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value; }];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ to, children }: { to: string; children: import("react").ReactNode }) => createElement("a", { href: to }, children) }));
vi.mock("../api.ts", () => ({ ...api, addTenantStage: vi.fn() }));

const row = (stage: TenantView["stage"], status: TenantView["status"]): TenantView => ({
  id: `tnt_${stage}`, guid: "zsjs023ctne0", stage, status, clusterId: "cls_1", domain: "apps1.example", approvedTags: {},
} as TenantView);
function render(tenant: TenantView): string {
  hooks.cursor = 0;
  return renderToStaticMarkup(createElement(TenantStageActions, { tenant }));
}
async function loaded(siblings: TenantView[]): Promise<string> {
  api.listTenants.mockResolvedValue(siblings);
  api.listTenantTargets.mockResolvedValue([{ id: "cls_1", domain: "apps1.example", status: "active" }]);
  render(siblings.find((t) => t.stage === "prod")!);
  for (const effect of hooks.effects.splice(0)) effect();
  await vi.waitFor(() => expect(hooks.states[6]).toBe(true));
  return render(siblings.find((t) => t.stage === "prod")!);
}
beforeEach(() => { hooks.states = []; hooks.cursor = 0; hooks.effects = []; vi.clearAllMocks(); });

describe("public Add stage recovery", () => {
  it.each(["dev", "test"] as const)("offers and initially selects purged %s while keeping its history", async (stage) => {
    const html = await loaded([row("prod", "active"), row("test", stage === "test" ? "purged" : "active"), row("dev", stage === "dev" ? "purged" : "active")]);
    expect(html).toContain(`<option selected="">${stage}</option>`);
    expect(html).toContain('Validate &amp; plan Add stage');
    expect(html).toContain(`/tenants/tnt_${stage}`);
    expect(html).toContain('purged');
  });
  it.each(["active", "suspended", "provisioning", "offboarded"] as const)("keeps %s stages occupied", async (status) => {
    const html = await loaded([row("prod", "active"), row("dev", "active"), row("test", status)]);
    expect(html).not.toContain('Validate &amp; plan Add stage');
    expect(html).toContain(`/tenants/tnt_test`);
  });
});
