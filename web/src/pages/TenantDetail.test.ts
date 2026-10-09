import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { TenantDetailView } from "../api.ts";

// The tenant page, driven without a DOM: the component is called as a function and the elements it
// returns are read. Its useState slots are kept across calls by this minimal hook store, and its
// effects are run by hand so the tenant and the catalog load the way they do in the browser.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
const api = vi.hoisted(() => ({ getTenant: vi.fn(), getTenantAppCatalog: vi.fn(), listRuns: vi.fn(), listTenants: vi.fn(), planRun: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
vi.mock("react-router", async (original) => ({ ...(await original<typeof import("react-router")>()), useNavigate: () => navigate, useParams: () => ({ id: "tnt_1" }) }));
vi.mock("../api.ts", async (original) => ({ ...(await original<typeof import("../api.ts")>()), ...api }));
const { TenantDetail } = await import("./TenantDetail.tsx");
const { TenantAppList } = await import("../components/TenantAppList.tsx");
const { TenantWebsites } = await import("../components/TenantWebsites.tsx");
const { ConfirmDialog } = await import("../components/ConfirmDialog.tsx");
const { tenantConfirmTitle } = await import("../tenantRows.ts");

const tenant = (status: TenantDetailView["status"]): TenantDetailView => ({
  id: "tnt_1", guid: "tenant1guid", subdomain: "simetrix", stage: "prod", status, clusterId: "cls_1", domain: "apps2.example", suspended: false, approvedTags: {},
  apps: [
    { id: "tna_erp", name: "erp", status: "offboarded", lastRunId: "run_erp", site: null, createdAt: 1 },
    { id: "tna_site", name: "simetrix-ch", status: "offboarded", lastRunId: "run_site", site: "simetrix-ch", createdAt: 1 },
  ],
} as TenantDetailView);
const catalog: TenantAppCatalogView = {
  apps: [{ name: "web", title: "Web", description: "", selections: {}, deployed: true, sites: ["simetrix-ch"] }],
  websites: [],
  members: ["web"],
};

const render = (): ReactElement => { hooks.cursor = 0; return TenantDetail() as ReactElement; };
function find<P>(node: ReactNode, type: unknown): ReactElement<P> | undefined {
  if (Array.isArray(node)) return node.map((n) => find<P>(n, type)).find((n) => n !== undefined);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as ReactElement<{ children?: ReactNode }>;
  return (el.type === type ? (el as ReactElement<P>) : undefined) ?? find<P>(el.props.children, type);
}
/** The page after the tenant and the catalog have loaded. */
async function loaded(status: TenantDetailView["status"]): Promise<ReactElement> {
  api.getTenant.mockResolvedValue(tenant(status));
  api.getTenantAppCatalog.mockResolvedValue(catalog);
  render();
  for (const effect of hooks.effects.splice(0)) effect();
  await vi.waitFor(() => expect(find(render(), TenantAppList)).toBeDefined());
  return render();
}
const dialog = () => find<{ title: string; children: ReactNode; onConfirm: () => void }>(render(), ConfirmDialog);
const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" && "props" in node ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children) : "";
};

beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.clearAllMocks();
  api.listRuns.mockResolvedValue([]);
  api.listTenants.mockResolvedValue([]);
  api.planRun.mockResolvedValue({ runId: "run_purge" });
});

describe("Purge on the tenant page", () => {
  it("opens one confirmation for a removed website, as for an app, and plans the same run for it", async () => {
    const page = await loaded("active");
    expect(find(page, ConfirmDialog)).toBeUndefined();
    find<{ onPurge: (app: string) => void }>(page, TenantWebsites)!.props.onPurge("simetrix-ch");
    expect(dialog()?.props.title).toBe(tenantConfirmTitle.purgeApp(tenant("active"), "simetrix-ch"));
    dialog()!.props.onConfirm();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/runs/run_purge"));
    expect(api.planRun).toHaveBeenCalledWith("tenant-purge-app", { tenantId: "tnt_1", app: "simetrix-ch" });
    expect(find(render(), ConfirmDialog)).toBeUndefined();
  });

  it("opens that same confirmation for an offboarded app of the Apps list", async () => {
    const page = await loaded("active");
    find<{ onPurge: (app: string) => void }>(page, TenantAppList)!.props.onPurge("erp");
    expect(dialog()?.props.title).toBe(tenantConfirmTitle.purgeApp(tenant("active"), "erp"));
    dialog()!.props.onConfirm();
    await vi.waitFor(() => expect(api.planRun).toHaveBeenCalledWith("tenant-purge-app", { tenantId: "tnt_1", app: "erp" }));
  });

  it("says in the confirmation that the purge deletes the app's empty member namespace, and still refuses while the app is deployed", async () => {
    const page = await loaded("active");
    find<{ onPurge: (app: string) => void }>(page, TenantAppList)!.props.onPurge("erp");
    const text = textOf(dialog()?.props.children);
    expect(text).toContain("its member namespace where it stands empty");
    expect(text).toContain("It refuses while the app is still deployed.");
  });

  it("offers neither list a Purge on a tenant that is settled or unfinished: only a standing tenant is edited", async () => {
    for (const status of ["offboarded", "provisioning"] as const) {
      hooks.states = [];
      const page = await loaded(status);
      expect(find(page, TenantWebsites), status).toBeUndefined();
      expect(find<{ editable: boolean }>(page, TenantAppList)?.props.editable, status).toBe(false);
    }
  });
});
