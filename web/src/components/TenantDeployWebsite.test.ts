import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactElement, type ReactNode } from "react";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";

// The Websites section and the dialog of its Deploy button, driven without a DOM: the useState slots
// are kept by a minimal hook store, and the components are called as functions whose elements are read.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
const api = vi.hoisted(() => ({ addTenantWebsite: vi.fn(), setTenantMainWebsite: vi.fn(), setTenantWebsiteDomain: vi.fn(), setTenantWebsiteSite: vi.fn() }));
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
const { websiteSiteDialogConfirm } = await import("../tenantAppRows.ts");

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
const live = [{ name: "simplidigita-ai", site: "simplidigita-ai", domain: "simplidigita.ai", aliases: [] as string[], main: false }];
const act = vi.fn(async (fn: () => Promise<{ runId: string }>) => { await fn(); });
const section = (over: Partial<Parameters<typeof TenantWebsites>[0]> = {}): ReactNode => {
  hooks.cursor = 0;
  return TenantWebsites({ tenantId: "tnt_1", catalog, websites: live, removed: [], busy: false, act, onRemove: vi.fn(), onPurge: vi.fn(), onRecordPackagesReader: async () => undefined, ...over });
};
const dialog = (over: Partial<Parameters<typeof TenantDeployWebsiteDialog>[0]> = {}): El => {
  hooks.cursor = 0;
  return TenantDeployWebsiteDialog({ tenantId: "tnt_1", folder: "web", site: "simetrix-ch", name: "simetrix-ch", firstWebsite: false, mainWebsite: null, act, onClose: vi.fn(), ...over }) as El;
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
    const both = [...live, { name: "simetrix-ch", site: "simetrix-ch", domain: "simetrix.ch", aliases: [] as string[], main: false }];
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
    expect(api.addTenantWebsite).toHaveBeenCalledWith("tnt_1", { app: "simetrix-ch", domain: "example.ch", site: "simetrix-ch", folder: "web", main: false });
  });

  it("PLANTED INNOCENT: asks for the domain before it can confirm, and a name that differs from the site is the app name", async () => {
    expect(dialog({ name: "simetrix-ch-2" }).props.confirmDisabled).toBe(true);
    domainField(dialog({ name: "simetrix-ch-2" })).props.onChange({ target: { value: "simetrix.example" } });
    const onClose = vi.fn();
    dialog({ name: "simetrix-ch-2", onClose }).props.onConfirm();
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(api.addTenantWebsite).toHaveBeenCalledWith("tnt_1", { app: "simetrix-ch-2", domain: "simetrix.example", site: "simetrix-ch", folder: "web", main: false }));
  });
});

const mainBox = (el: El): El => find(el, (e) => e.type === "input" && (e.props as { type?: string }).type === "checkbox")[0]!;
const textOf = (node: ReactNode): string => (Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? textOf((node as El).props.children) : "");
const ticked = (el: El): boolean => (mainBox(el).props as { checked?: boolean }).checked === true;

describe("the Deploy dialog's Hauptseite unter /", () => {
  it("PLANTED DEFECT: is ticked for the tenant's first website and unticked for a later one", () => {
    expect(ticked(dialog({ firstWebsite: true }))).toBe(true);
    hooks.states = [];
    expect(ticked(dialog({ firstWebsite: false }))).toBe(false);
  });

  it("PLANTED DEFECT: sends the box as `main` with the request", async () => {
    domainField(dialog({ firstWebsite: true })).props.onChange({ target: { value: "example.ch" } });
    dialog({ firstWebsite: true }).props.onConfirm();
    await vi.waitFor(() => expect(api.addTenantWebsite).toHaveBeenCalledWith("tnt_1", expect.objectContaining({ domain: "example.ch", main: true })));
    hooks.states = [];
    domainField(dialog()).props.onChange({ target: { value: "example.ch" } });
    mainBox(dialog()).props.onChange({ target: { checked: true } });
    dialog().props.onConfirm();
    await vi.waitFor(() => expect(api.addTenantWebsite).toHaveBeenLastCalledWith("tnt_1", expect.objectContaining({ main: true })));
  });

  it("says the website becomes the main website once ticked, names the website that loses the mark, and says nothing of it unticked", () => {
    const text = textOf(dialog({ firstWebsite: true, mainWebsite: "old-site" }));
    expect(text).toContain("it becomes the tenant's main website");
    expect(text).toContain("old-site is the main website now and loses it");
    expect(textOf(dialog({ firstWebsite: true, mainWebsite: null }))).not.toContain("loses it");
    hooks.states = [];
    expect(textOf(dialog({ firstWebsite: false, mainWebsite: "old-site" }))).not.toContain("main website");
  });

  it("the section passes firstWebsite for a tenant without a website, and the website that holds the mark", () => {
    const dialogOf = (websites: typeof live) => {
      hooks.states = [];
      deployButtons(section({ websites }))[0]!.props.onClick();
      return find(section({ websites }), (el) => el.type === TenantDeployWebsiteDialog)[0]!.props;
    };
    expect(dialogOf([])).toMatchObject({ firstWebsite: true, mainWebsite: null });
    expect(dialogOf(live)).toMatchObject({ firstWebsite: false, mainWebsite: null });
    expect(dialogOf([{ ...live[0]!, main: true }])).toMatchObject({ firstWebsite: false, mainWebsite: "simplidigita-ai" });
  });
});

describe("the Site… dialog's Hauptseite unter /", () => {
  const open = (main: boolean): void => {
    hooks.states = [];
    const row = find(section({ websites: [{ ...live[0]!, main }] }), (el) => el.type === "button" && el.props.children === "Site…")[0]!;
    row.props.onClick();
  };
  const siteDialog = (main: boolean): El => find(section({ websites: [{ ...live[0]!, main }] }), (el) => el.type === ConfirmDialog)[0]!;
  const siteField = (main: boolean): El => find(siteDialog(main), (e) => e.type === "input" && (e.props as { placeholder?: string }).placeholder === "simplidigita-ai")[0]!;

  it("PLANTED DEFECT: shows the mark ticked and disabled on the main website, and its confirm moves nothing", () => {
    open(true);
    const box = mainBox(siteDialog(true)).props as { checked?: boolean; disabled?: boolean };
    expect([box.checked, box.disabled]).toEqual([true, true]);
    expect(textOf(siteDialog(true))).toContain("This is the main website; mark another website to move it.");
    expect(siteDialog(true).props.confirmDisabled).toBe(true);
  });

  it("PLANTED DEFECT: on another website, the ticked mark with no site plans the main run and not a site move", async () => {
    open(false);
    expect(siteDialog(false).props.confirmDisabled).toBe(true);
    mainBox(siteDialog(false)).props.onChange({ target: { checked: true } });
    expect(siteDialog(false).props).toMatchObject({ confirmLabel: "Make it the main website", confirmDisabled: false });
    api.setTenantMainWebsite.mockResolvedValue({ runId: "run_2" });
    siteDialog(false).props.onConfirm();
    await vi.waitFor(() => expect(api.setTenantMainWebsite).toHaveBeenCalledWith("tnt_1", "simplidigita-ai"));
    expect(api.setTenantWebsiteSite).not.toHaveBeenCalled();
  });

  it("PLANTED DEFECT: refuses the mark together with a site move, with one line that says why", () => {
    open(false);
    mainBox(siteDialog(false)).props.onChange({ target: { checked: true } });
    siteField(false).props.onChange({ target: { value: "renamed" } });
    expect(siteDialog(false).props.confirmDisabled).toBe(true);
    expect(textOf(siteDialog(false))).toContain("two runs");
  });

  it("PLANTED INNOCENT: an unticked mark leaves the site move as it was", () => {
    expect(websiteSiteDialogConfirm({ site: "main", main: false }, "renamed", "0.1.1-stable-20260201000000-def5678", false)).toEqual({ label: "Serve site renamed on 0.1.1-stable-20260201000000-def5678", why: null });
    expect(websiteSiteDialogConfirm({ site: "main", main: true }, "", "", false)).toEqual({ label: null, why: null });
  });
});
