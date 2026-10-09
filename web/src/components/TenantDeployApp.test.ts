import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactElement, type ReactNode } from "react";
import type { TenantAppCatalogView, TenantCatalogAppView } from "../../../shared/apps-manifest.ts";
import type { TenantDetailView } from "../api.ts";

// The Apps list and the dialog of its Deploy button, driven without a DOM: the useState slots are kept
// by a minimal hook store, and the components are called as functions whose elements are read.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
const api = vi.hoisted(() => ({ addTenantApp: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(hooks.states[index]) : next; }];
  },
}));
vi.mock("../api.ts", () => api);
const { TenantAppList } = await import("./TenantAppList.tsx");
const { TenantDeployAppDialog } = await import("./TenantDeployAppDialog.tsx");
const { ConfirmDialog } = await import("./ConfirmDialog.tsx");

interface Props { children?: ReactNode; disabled?: boolean; checked?: boolean; onClick: () => void; onChange: (e: unknown) => void; onConfirm: () => void; onClose: () => void; confirmLabel: string; app: TenantCatalogAppView; tenantId: string }
type El = ReactElement<Props>;
function find(node: ReactNode, match: (el: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, match));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as El;
  return [...(match(el) ? [el] : []), ...find(el.props.children, match)];
}
const deployButtons = (node: ReactNode): El[] => find(node, (el) => el.type === "button" && el.props.children === "Deploy");

const selections = { seedReference: { title: "Reference data", default: true }, seedDemo: { title: "Demo data", default: true } };
const workshop: TenantCatalogAppView = { name: "workshop", title: "Workshop", description: "Job cards and invoices", selections, deployed: false };
const crm: TenantCatalogAppView = { name: "crm", title: "CRM", description: "", selections: {}, deployed: true };
const catalog: TenantAppCatalogView = { apps: [crm, workshop], websites: [], members: ["crm"] };
const tenant = { id: "tnt_1", guid: "abc123", stage: "prod", status: "active", apps: [{ id: "tna_crm", name: "crm", status: "active", lastRunId: null }] } as unknown as TenantDetailView;
const act = vi.fn(async (fn: () => Promise<{ runId: string }>) => { await fn(); });
const list = (over: Partial<Parameters<typeof TenantAppList>[0]> = {}): ReactNode => {
  hooks.cursor = 0;
  return TenantAppList({ tenant, catalog, editable: true, busy: false, act, onRemove: vi.fn(), onPurge: vi.fn(), onRecordPackagesReader: async () => undefined, ...over });
};
const dialog = (app: TenantCatalogAppView, onClose = vi.fn()): El => {
  hooks.cursor = 0;
  return TenantDeployAppDialog({ tenantId: "tnt_1", app, act, onClose }) as El;
};
const box = (el: El, title: string): El =>
  find(el, (e) => e.type === "label" && find(e, (s) => s.type === "span" && s.props.children === title).length > 0).flatMap((label) => find(label, (i) => i.type === "input"))[0]!;

beforeEach(() => { hooks.states = []; hooks.cursor = 0; vi.clearAllMocks(); api.addTenantApp.mockResolvedValue({ runId: "run_1" }); });

describe("the Apps list offers Deploy on a bundle app that is not deployed", () => {
  it("PLANTED DEFECT: Deploy stands on the not-deployed row only, never on a deployed one", () => {
    const rows = find(list(), (el) => el.type === "li");
    const buttonsOf = (name: string): El[] => deployButtons(rows.find((li) => li.key === name));
    expect(buttonsOf("workshop")).toHaveLength(1);
    expect(buttonsOf("crm")).toHaveLength(0);
    expect(deployButtons(list())).toHaveLength(1);
  });

  it("PLANTED INNOCENT: a deployed-only bundle shows no Deploy button at all", () => {
    const deployedAll = { apps: [crm, { ...workshop, deployed: true }], websites: [], members: ["crm", "workshop"] };
    expect(deployButtons(list({ catalog: deployedAll }))).toHaveLength(0);
  });

  it("offers no Deploy on a tenant the page does not edit, and none while the catalog is unreadable", () => {
    expect(deployButtons(list({ editable: false }))).toHaveLength(0);
    expect(deployButtons(list({ catalog: { apps: [], error: "clone failed" } }))).toHaveLength(0);
  });

  it("holds Deploy while a trigger runs or the owner's packages reader is not recorded", () => {
    expect(deployButtons(list({ busy: true }))[0]!.props.disabled).toBe(true);
    expect(deployButtons(list())[0]!.props.disabled).toBe(false);
    const waiting = { ...catalog, packagesReader: { owner: "acme", scopes: ["acme"], recorded: null } };
    expect(deployButtons(list({ catalog: waiting }))[0]!.props.disabled).toBe(true);
  });

  it("opens the dialog of the row's own app, and closes it again", () => {
    deployButtons(list())[0]!.props.onClick();
    const open = find(list(), (el) => el.type === TenantDeployAppDialog);
    expect(open).toHaveLength(1);
    expect(open[0]!.props.app).toBe(workshop);
    expect(open[0]!.props.tenantId).toBe("tnt_1");
    open[0]!.props.onClose();
    expect(find(list(), (el) => el.type === TenantDeployAppDialog)).toHaveLength(0);
  });
});

describe("the Deploy dialog of an app", () => {
  it("PLANTED DEFECT: confirms with the selections as they stand, a box unticked stays off", async () => {
    box(dialog(workshop), "Demo data").props.onChange({ target: { checked: false } });
    const confirm = dialog(workshop);
    expect(box(confirm, "Reference data").props.checked).toBe(true);
    expect(box(confirm, "Demo data").props.checked).toBe(false);
    confirm.props.onConfirm();
    await vi.waitFor(() => expect(api.addTenantApp).toHaveBeenCalledTimes(1));
    expect(api.addTenantApp).toHaveBeenCalledWith("tnt_1", "workshop", { seedReference: true, seedDemo: false, selections: {} });
  });

  it("PLANTED INNOCENT: starts every box at the default its entry declares and plans exactly those", async () => {
    const entry = { ...workshop, selections: { seedReference: { title: "Reference data", default: true }, seedDemo: { title: "Demo data", default: false }, portal: { title: "Customer portal", default: true } } };
    const confirm = dialog(entry);
    expect(["Reference data", "Demo data", "Customer portal"].map((title) => box(confirm, title).props.checked)).toEqual([true, false, true]);
    confirm.props.onConfirm();
    await vi.waitFor(() => expect(api.addTenantApp).toHaveBeenCalledTimes(1));
    expect(api.addTenantApp).toHaveBeenCalledWith("tnt_1", "workshop", { seedReference: true, seedDemo: false, selections: { portal: true } });
  });

  it("closes itself on confirm, hands the plan to act, and shows no checkbox for an app without selections", async () => {
    const onClose = vi.fn();
    const plain = dialog({ ...workshop, selections: {} }, onClose);
    expect(find(plain, (el) => el.type === "input")).toHaveLength(0);
    expect(plain.type).toBe(ConfirmDialog);
    expect(plain.props.confirmLabel).toBe("Deploy");
    plain.props.onConfirm();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(api.addTenantApp).toHaveBeenCalledWith("tnt_1", "workshop", { seedReference: false, seedDemo: false, selections: {} }));
  });
});
