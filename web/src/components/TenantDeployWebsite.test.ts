import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactElement, type ReactNode } from "react";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";

// The Websites section and the dialog of its Deploy button, driven without a DOM: the useState slots
// are kept by a minimal hook store, and the components are called as functions whose elements are read.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
const api = vi.hoisted(() => ({ addTenantWebsite: vi.fn(), setTenantWebsiteDomain: vi.fn(), setTenantWebsiteSite: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(hooks.states[index]) : next; }];
  },
}));
vi.mock("../api-tenant-websites.ts", () => api);
const { TenantWebsites } = await import("./TenantWebsites.tsx");
const { TenantDeployWebsiteDialog } = await import("./TenantDeployWebsiteDialog.tsx");
const { ConfirmDialog } = await import("./ConfirmDialog.tsx");

interface Props { children?: ReactNode; disabled?: boolean; onClick: () => void; onChange: (e: unknown) => void; onConfirm: () => void; onClose: () => void; confirmLabel: string; confirmDisabled: boolean }
type El = ReactElement<Props>;
function find(node: ReactNode, match: (el: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, match));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as El;
  return [...(match(el) ? [el] : []), ...find(el.props.children, match)];
}
const deployButtons = (node: ReactNode): El[] => find(node, (el) => el.type === "button" && el.props.children === "Deploy");

const folder = { name: "web", title: "Web", description: "", selections: {}, deployed: true, sites: ["simetrix-ch", "simplidigita-ai"] };
const catalog: TenantAppCatalogView = { apps: [folder], websites: [{ name: "simplidigita-ai", site: "simplidigita-ai", domain: "simplidigita.ai" }], members: ["web", "simplidigita-ai"] };
const live = [{ name: "simplidigita-ai", site: "simplidigita-ai", domain: "simplidigita.ai", aliases: [] as string[] }];
const act = vi.fn(async (fn: () => Promise<{ runId: string }>) => { await fn(); });
const section = (over: Partial<Parameters<typeof TenantWebsites>[0]> = {}): ReactNode => {
  hooks.cursor = 0;
  return TenantWebsites({ tenantId: "tnt_1", catalog, websites: live, removed: [], busy: false, act, onRemove: vi.fn(), onPurge: vi.fn(), onRecordPackagesReader: async () => undefined, ...over });
};
const dialog = (over: Partial<Parameters<typeof TenantDeployWebsiteDialog>[0]> = {}): El => {
  hooks.cursor = 0;
  return TenantDeployWebsiteDialog({ tenantId: "tnt_1", folder: "web", site: "simetrix-ch", name: "simetrix-ch", act, onClose: vi.fn(), ...over }) as El;
};
const domainField = (el: El): El => find(el, (e) => e.type === "input")[0]!;

beforeEach(() => { hooks.states = []; hooks.cursor = 0; vi.clearAllMocks(); api.addTenantWebsite.mockResolvedValue({ runId: "run_1" }); });

describe("the Websites section offers Deploy on a bundle site that is not deployed", () => {
  it("PLANTED DEFECT: Deploy stands on the not-deployed site's row only, never on a deployed website", () => {
    const rows = find(section(), (el) => el.type === "li");
    expect(rows.map((li) => li.key)).toEqual(["simplidigita-ai", "bundle-simetrix-ch"]);
    expect(deployButtons(rows[0])).toHaveLength(0);
    expect(deployButtons(rows[1])).toHaveLength(1);
    expect(deployButtons(section())).toHaveLength(1);
  });

  it("PLANTED INNOCENT: a bundle whose every site is deployed shows no Deploy button", () => {
    const deployedAll: TenantAppCatalogView = { ...catalog, websites: [...catalog.websites!, { name: "simetrix-ch", site: "simetrix-ch", domain: "simetrix.ch" }] };
    const both = [...live, { name: "simetrix-ch", site: "simetrix-ch", domain: "simetrix.ch", aliases: [] as string[] }];
    const rows = find(section({ catalog: deployedAll, websites: both }), (el) => el.type === "li");
    expect(rows.map((li) => li.key)).toEqual(["simplidigita-ai", "simetrix-ch"]);
    expect(deployButtons(section({ catalog: deployedAll, websites: both }))).toHaveLength(0);
  });

  it("holds Deploy while a trigger runs or the owner's packages reader is not recorded", () => {
    expect(deployButtons(section({ busy: true }))[0]!.props.disabled).toBe(true);
    expect(deployButtons(section())[0]!.props.disabled).toBe(false);
    const waiting = { ...catalog, packagesReader: { owner: "acme", scopes: ["acme"], recorded: null } };
    expect(deployButtons(section({ catalog: waiting }))[0]!.props.disabled).toBe(true);
  });

  it("opens the dialog of the row's own site, named clear of the tenant's members, and closes it again", () => {
    const clash = { ...catalog, members: [...catalog.members!, "simetrix-ch"] };
    deployButtons(section({ catalog: clash }))[0]!.props.onClick();
    const open = find(section({ catalog: clash }), (el) => el.type === TenantDeployWebsiteDialog);
    expect(open).toHaveLength(1);
    expect(open[0]!.props).toMatchObject({ tenantId: "tnt_1", folder: "web", site: "simetrix-ch", name: "simetrix-ch-2" });
    open[0]!.props.onClose();
    expect(find(section({ catalog: clash }), (el) => el.type === TenantDeployWebsiteDialog)).toHaveLength(0);
  });
});

describe("the Deploy dialog of a website", () => {
  it("PLANTED DEFECT: confirms with the typed domain, without www and in lower case, and the site's own name and folder", async () => {
    domainField(dialog()).props.onChange({ target: { value: "  Example.CH " } });
    const confirm = dialog();
    expect(confirm.type).toBe(ConfirmDialog);
    expect(confirm.props.confirmLabel).toBe("Deploy");
    expect(confirm.props.confirmDisabled).toBe(false);
    confirm.props.onConfirm();
    await vi.waitFor(() => expect(api.addTenantWebsite).toHaveBeenCalledTimes(1));
    expect(api.addTenantWebsite).toHaveBeenCalledWith("tnt_1", { app: "simetrix-ch", domain: "example.ch", site: "simetrix-ch", folder: "web" });
  });

  it("PLANTED INNOCENT: asks for the domain before it can confirm, and a name that differs from the site is the app name", async () => {
    expect(dialog({ name: "simetrix-ch-2" }).props.confirmDisabled).toBe(true);
    domainField(dialog({ name: "simetrix-ch-2" })).props.onChange({ target: { value: "simetrix.example" } });
    const onClose = vi.fn();
    dialog({ name: "simetrix-ch-2", onClose }).props.onConfirm();
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(api.addTenantWebsite).toHaveBeenCalledWith("tnt_1", { app: "simetrix-ch-2", domain: "simetrix.example", site: "simetrix-ch", folder: "web" }));
  });
});
