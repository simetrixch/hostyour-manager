import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { TenantView } from "../api.ts";

// The dialog's handlers, driven without a DOM: the component is called as a function, its useState
// slots kept across calls by this minimal hook store.
const slots: unknown[] = [];
let slot = 0;
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <S,>(initial: S) => {
    const i = slot++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i] as S, (next: S) => { slots[i] = next; }];
  },
}));
const api = vi.hoisted(() => ({ listTenants: vi.fn(), listTenantTargets: vi.fn() }));
vi.mock("../api.ts", async (original) => ({ ...(await original<typeof import("../api.ts")>()), ...api }));
const { TenantMoveAction, TenantMoveConfirm } = await import("./TenantMoveAction.tsx");

const row = (stage: TenantView["stage"]): TenantView =>
  ({ id: `tnt_${stage}`, guid: "tenant1", subdomain: "demo", stage, status: "active", clusterId: `cls_${stage}`, domain: "apps1.example", suspended: false } as TenantView);
const all = [row("prod"), row("test")];
const render = (): ReactElement => { slot = 0; return TenantMoveAction({ tenant: all[1]!, environments: all, onCancel: () => undefined, onConfirm: () => undefined }) as ReactElement; };
const radios = (node: ReactNode): ReactElement<{ value: string; onChange: () => void }>[] => {
  if (Array.isArray(node)) return node.flatMap(radios);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ type?: string; children?: ReactNode; value: string; onChange: () => void }>;
  return [...(el.type === "input" && el.props.type === "radio" ? [el] : []), ...radios(el.props.children)];
};

describe("the Move dialog's wiring", () => {
  it("moves the row the operator picked, not the page's", () => {
    slots.length = 0;
    radios(render()).find((r) => r.props.value === "tnt_prod")!.props.onChange();
    (render().props as { onConfirm: () => void }).onConfirm();
    const next = render();
    expect(next.type).toBe(TenantMoveConfirm);
    expect((next.props as { tenant: TenantView }).tenant.id).toBe("tnt_prod");
  });
});

describe("the Move dialog's machine list", () => {
  const targets = ["cls_prod", "cls_dev", "cls_free", "cls_elsewhere"].map((id) => ({ id }));
  const listed = async (rows: TenantView[]): Promise<string[]> => {
    slots.length = 0; slot = 0;
    api.listTenants.mockResolvedValue(rows);
    api.listTenantTargets.mockResolvedValue(targets);
    const dialog = TenantMoveConfirm({ tenant: all[1]!, onCancel: () => undefined, onConfirm: () => undefined }) as ReactElement<{ loadTargets: () => Promise<{ id: string }[]> }>;
    return (await dialog.props.loadTargets()).map((t) => t.id);
  };
  const other = { ...row("prod"), id: "tnt_other", guid: "other", clusterId: "cls_elsewhere" };

  it("PLANTED DEFECT: leaves out the machine PROD of the same tenant stands on", async () => {
    expect(await listed([...all, other])).toEqual(["cls_dev", "cls_free", "cls_elsewhere"]);
  });

  it("PLANTED INNOCENT: keeps the machine of a purged PROD and the machine of a DEV", async () => {
    expect(await listed([all[1]!, { ...all[0]!, status: "purged" }, { ...row("dev"), clusterId: "cls_dev" }])).toEqual(["cls_prod", "cls_dev", "cls_free", "cls_elsewhere"]);
  });
});
