import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Stage } from "../../../shared/enums.ts";

// The create wizard, driven without a DOM: its useState slots are seeded and kept by this minimal
// hook store, so it is rendered to markup or called as a function whose elements are read.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
const api = vi.hoisted(() => ({ listTenantTargets: vi.fn(), createTenant: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(hooks.states[index]) : next; }];
  },
  useEffect: () => undefined,
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../api.ts", () => api);
const { TenantCreate } = await import("./TenantCreate.tsx");

// apps4 is removed; every other machine is active and serves the one stage it names.
const machines = [["apps1", "prod"], ["apps2", "test"], ["apps3", "dev"], ["apps4", "prod"], ["apps5", "prod"]]
  .map(([name, stage], i) => ({ id: `cls_${i + 1}`, domain: `${name}.example`, stage, status: name === "apps4" ? "removed" : "active" }));
const form = { subdomain: "acme", displayName: "", owner: "team-acme", clusterId: "cls_1", adminEmail: "", size: "small" };
const seed = (selected: Stage[], chosen: Partial<Record<Stage, string>> = {}, defaultMachine = form.clusterId): void => {
  hooks.states = [{ ...form, clusterId: defaultMachine }, selected, chosen, false, machines, false, null]; hooks.cursor = 0;
};
const render = (): string => { hooks.cursor = 0; return renderToStaticMarkup(createElement(TenantCreate)); };
/** What one stage's machine select shows: the machines it offers and the one it stands on, if any. */
function machineSelect(html: string, stage: Stage): { offered: string[]; selected: string } {
  const select = new RegExp(`${stage} machine</span><select[^>]*>(.*?)</select>`).exec(html)![1]!;
  return { offered: [...select.matchAll(/<option value="(cls_\d)"/g)].map((m) => m[1]!), selected: /<option value="([^"]*)"[^>]*selected/.exec(select)![1]! };
}
const submitDisabled = (html: string): boolean => /<button type="submit"[^>]*disabled=""/.test(html);
function elements(node: ReactNode, type: string): ReactElement<{ type?: string; onSubmit: (e: unknown) => unknown; onChange: (e: unknown) => unknown }>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; type?: string; onSubmit: (e: unknown) => unknown; onChange: (e: unknown) => unknown }>;
  return [...(el.type === type ? [el] : []), ...elements(el.props.children, type)];
}

beforeEach(() => { vi.clearAllMocks(); api.createTenant.mockResolvedValue({ runId: "run_1" }); });

describe("the create wizard offers each stage only the machines that serve it", () => {
  const submit = () => elements(TenantCreate() as ReactElement, "form")[0]!.props.onSubmit({ preventDefault: () => undefined });

  it("PLANTED DEFECT: TEST is offered no PROD machine, and PROD no TEST machine", () => {
    seed(["test", "prod"]);
    const html = render();
    expect(machineSelect(html, "prod")).toEqual({ offered: ["cls_1", "cls_5"], selected: "cls_1" });
    expect(machineSelect(html, "test")).toEqual({ offered: ["cls_2"], selected: "" });
    expect(submitDisabled(html)).toBe(true);
  });

  it("PLANTED DEFECT: the default machine does not stand in for a stage it does not serve", async () => {
    seed(["dev"]);
    const html = render();
    expect(machineSelect(html, "dev")).toEqual({ offered: ["cls_3"], selected: "" });
    expect(submitDisabled(html)).toBe(true);
    hooks.cursor = 0;
    await submit();
    expect(api.createTenant).not.toHaveBeenCalled();
    expect(hooks.states[6]).toBe("Choose a machine for every stage.");
  });

  it("PLANTED INNOCENT: submits each stage on a machine of its own stage, the default standing in for PROD", async () => {
    seed(["dev", "test", "prod"], { dev: "cls_3", test: "cls_2" });
    expect(submitDisabled(render())).toBe(false);
    hooks.cursor = 0;
    await submit();
    expect(api.createTenant).toHaveBeenCalledWith(expect.objectContaining({ stages: [{ stage: "dev", clusterId: "cls_3" }, { stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_1" }] }));
  });

  it("PLANTED INNOCENT: TEST and PROD with their own machines need no default machine", async () => {
    seed(["test", "prod"], { test: "cls_2", prod: "cls_5" }, "");
    expect(submitDisabled(render())).toBe(false);
    hooks.cursor = 0;
    await submit();
    expect(api.createTenant).toHaveBeenCalledWith(expect.objectContaining({ clusterId: "cls_2", stages: [{ stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_5" }] }));
  });

  it("forgets the machine of a stage that is unselected, so selecting it again cannot bring back a conflicting choice", () => {
    seed(["test", "prod"], { test: "cls_2", prod: "cls_1" });
    const [, testBox] = elements(TenantCreate() as ReactElement, "input").filter((input) => input.props.type === "checkbox");
    testBox!.props.onChange({ target: { checked: false } });
    expect(hooks.states[1]).toEqual(["prod"]);
    expect(hooks.states[2]).toEqual({ prod: "cls_1" });
  });
});
