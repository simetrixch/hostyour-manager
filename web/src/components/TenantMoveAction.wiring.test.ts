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
const api = vi.hoisted(() => ({ listTenantTargets: vi.fn() }));
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
  const targets = [["cls_prod", "prod"], ["cls_test", "test"], ["cls_test2", "test"], ["cls_dev", "dev"]].map(([id, stage]) => ({ id, stage }));
  const listed = async (tenant: TenantView): Promise<string[]> => {
    slots.length = 0; slot = 0;
    slots[0] = true; // past the typed confirmation PROD asks first
    api.listTenantTargets.mockResolvedValue(targets);
    const dialog = TenantMoveConfirm({ tenant, onCancel: () => undefined, onConfirm: () => undefined }) as ReactElement<{ loadTargets: () => Promise<{ id: string }[]> }>;
    return (await dialog.props.loadTargets()).map((t) => t.id);
  };

  it("PLANTED DEFECT: offers TEST no PROD machine, and PROD no TEST machine", async () => {
    expect(await listed(row("test"))).toEqual(["cls_test", "cls_test2"]);
    expect(await listed(row("prod"))).toEqual(["cls_prod"]);
  });

  it("PLANTED INNOCENT: offers DEV the machine that serves dev", async () => {
    expect(await listed(row("dev"))).toEqual(["cls_dev"]);
  });
});
