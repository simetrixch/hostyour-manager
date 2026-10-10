import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TenantView } from "../api.ts";
import { TenantStageActions } from "./TenantStageActions.tsx";

// Render the real selector after its existing asynchronous inventory load, without a browser.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
const api = vi.hoisted(() => ({ listTenants: vi.fn(), listTenantTargets: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value; }];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [search.params] }));
vi.mock("../api.ts", () => ({ ...api, addTenantStage: vi.fn() }));

const row = (stage: TenantView["stage"], status: TenantView["status"]): TenantView => ({
  id: `tnt_${stage}`, guid: "zsjs023ctne0", stage, status, clusterId: "cls_1", domain: "apps1.example", approvedTags: {},
} as TenantView);
function render(tenant: TenantView): string {
  hooks.cursor = 0;
  return renderToStaticMarkup(createElement(TenantStageActions, { tenant }));
}
const machine = (n: number, stage = "prod") => ({ id: `cls_${n}`, domain: `apps${n}.example`, stage, status: "active" });
const pageOf = (siblings: TenantView[]) => siblings.find((t) => t.stage === "prod") ?? siblings[0]!;
async function loaded(siblings: TenantView[], machines = [machine(1)]): Promise<string> {
  api.listTenants.mockResolvedValue(siblings);
  api.listTenantTargets.mockResolvedValue(machines);
  render(pageOf(siblings));
  for (const effect of hooks.effects.splice(0)) effect();
  await vi.waitFor(() => expect(hooks.states[7]).toBe(true));
  return render(pageOf(siblings));
}
beforeEach(() => { hooks.states = []; hooks.cursor = 0; hooks.effects = []; search.params = new URLSearchParams(); vi.clearAllMocks(); });

describe("public Add stage recovery", () => {
  it.each(["dev", "test"] as const)("offers and initially selects purged %s", async (stage) => {
    const html = await loaded([row("prod", "active"), row("test", stage === "test" ? "purged" : "active"), row("dev", stage === "dev" ? "purged" : "active")]);
    expect(html).toContain(`<option selected="">${stage}</option>`);
    expect(html).toContain('Validate &amp; plan Add stage');
  });
  it.each(["active", "suspended", "provisioning", "offboarded"] as const)("keeps %s stages occupied", async (status) => {
    const html = await loaded([row("prod", "active"), row("dev", "active"), row("test", status)]);
    expect(html).not.toContain('Validate &amp; plan Add stage');
  });
  it("opens on the environment whose + add was pressed", async () => {
    search.params = new URLSearchParams("addStage=test");
    const html = await loaded([row("prod", "active")]);
    expect(html).toContain('<option selected="">test</option>');
  });
});

describe("Add stage chooses its own machine and size", () => {
  it("preselects neither the machine of the page's stage nor a size", async () => {
    const html = await loaded([row("prod", "active"), row("test", "purged")]);
    expect(html).toContain('<option value="" disabled="" selected="">Choose a machine</option>');
    expect(html).toContain('<option value="" disabled="" selected="">Choose a size</option>');
    // A tenant is offered XS to L, by letter; XL and XXL are not offered yet.
    for (const [id, letter] of [["xsmall", "XS"], ["small", "S"], ["medium", "M"], ["large", "L"]]) expect(html).toContain(`<option value="${id}">${letter}</option>`);
    expect(html).not.toContain("xlarge");
    expect(html).toMatch(/<button class="btn" disabled="">Validate &amp; plan Add stage<\/button>/);
  });
});

describe("Add stage offers only the machines that serve its stage", () => {
  const machines = [machine(1, "prod"), machine(2, "test"), machine(3, "dev"), { ...machine(4, "test"), status: "removed" }];
  const offered = (html: string) => [...html.matchAll(/<option value="(cls_\d)">/g)].map((m) => m[1]);

  it("PLANTED DEFECT: offers TEST no PROD machine, and PROD no TEST machine", async () => {
    search.params = new URLSearchParams("addStage=test");
    expect(offered(await loaded([row("prod", "active")], machines))).toEqual(["cls_2"]);
    hooks.states = [];
    search.params = new URLSearchParams("addStage=prod");
    expect(offered(await loaded([row("test", "active")], machines))).toEqual(["cls_1"]);
  });

  it("PLANTED INNOCENT: offers DEV the machine that serves dev", async () => {
    search.params = new URLSearchParams("addStage=dev");
    expect(offered(await loaded([row("prod", "active")], machines))).toEqual(["cls_3"]);
  });

  it("PLANTED DEFECT: a machine chosen that does not serve the stage counts as not chosen", async () => {
    search.params = new URLSearchParams("addStage=test");
    const prod = row("prod", "active");
    await loaded([prod], machines);
    hooks.states[3] = "cls_1"; hooks.states[4] = "small";
    expect(render(prod)).toContain('<option value="" disabled="" selected="">Choose a machine</option>');
    expect(render(prod)).toMatch(/<button class="btn" disabled="">Validate/);
  });

  it("PLANTED INNOCENT: a machine chosen stays chosen while it serves the stage", async () => {
    search.params = new URLSearchParams("addStage=test");
    const prod = row("prod", "active");
    await loaded([prod], machines);
    hooks.states[3] = "cls_2"; hooks.states[4] = "small";
    expect(render(prod)).toContain('<option value="cls_2" selected="">apps2.example</option>');
    expect(render(prod)).toMatch(/<button class="btn">Validate/);
  });
});
