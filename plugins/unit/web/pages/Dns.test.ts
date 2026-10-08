import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DnsInventoryView, DnsWritesView } from "#core/shared/dns.ts";
import { ConfirmDialog } from "#core/web/components/ConfirmDialog.tsx";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));
const api = vi.hoisted(() => ({
  getDnsWrites: vi.fn(),
  getDnsInventory: vi.fn(),
  removeDnsRecords: vi.fn(),
}));
const nav = vi.hoisted(() => vi.fn());

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) {
      hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    const setter = (valueOrFn: unknown) => {
      const next = typeof valueOrFn === "function" ? (valueOrFn as (prev: unknown) => unknown)(hooks.states[index]) : valueOrFn;
      hooks.states[index] = next;
    };
    return [hooks.states[index], setter];
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useNavigate: () => nav,
  Link: (props: { children?: ReactNode }) => createElement("a", null, props.children),
}));
vi.mock("#core/web/api.ts", () => api);

const { Dns } = await import("./Dns.tsx");
const { recordKey } = await import("./DnsWrites.tsx");

function evaluate(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(evaluate);
  if (!isValidElement(node)) return node;
  if (node.type === ConfirmDialog) return node; // Keep ConfirmDialog as component element to inspect props
  if (typeof node.type === "function") {
    const fn = node.type as (props: unknown) => ReactNode;
    return evaluate(fn(node.props));
  }
  const props = { ...(node.props as Record<string, unknown>) };
  if ("children" in props) {
    props.children = evaluate(props.children as ReactNode);
  }
  return { ...node, props };
}

function findElements<P>(node: ReactNode, predicate: (el: ReactElement<P>) => boolean): ReactElement<P>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<P>;
  const rest = findElements((el.props as { children?: ReactNode })?.children, predicate);
  return predicate(el) ? [el, ...rest] : rest;
}

const sampleWrites: DnsWritesView = {
  readAt: "2026-10-07T12:00:00Z",
  skipped: [],
  rows: [
    {
      name: "app1.example.com",
      type: "CNAME",
      content: "cluster1.example.com",
      act: "inserted",
      owner: { kind: "consumer", name: "app1", stage: "prod" },
      runId: "run_1",
      writtenAt: "2026-10-07T10:00:00Z",
      found: "cluster1.example.com",
      verdict: "standing",
    },
    {
      name: "app2.example.com",
      type: "CNAME",
      content: "cluster1.example.com",
      act: "inserted",
      owner: { kind: "consumer", name: "app2", stage: "test" },
      runId: "run_2",
      writtenAt: "2026-10-07T10:00:00Z",
      found: "cluster1.example.com",
      verdict: "standing",
    },
  ],
};

const sampleInventory: DnsInventoryView = {
  readAt: "2026-10-07T12:00:00Z",
  skipped: [],
  rows: [
    {
      owner: { kind: "consumer", name: "app1", stage: "prod" },
      name: "app1.example.com",
      type: "CNAME",
      expected: "cluster1.example.com",
      found: "cluster1.example.com",
      verdict: "standing",
      removable: true,
    },
    {
      owner: { kind: "consumer", name: "app2", stage: "test" },
      name: "app2.example.com",
      type: "CNAME",
      expected: "cluster1.example.com",
      found: "cluster1.example.com",
      verdict: "standing",
      removable: true,
    },
  ],
};

describe("DNS page in-page confirmation", () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      confirm: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("pressing 'Remove selected (2)' with two rows ticked opens ConfirmDialog listing both records; cancel does not remove; confirm calls removeDnsRecords", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    api.getDnsWrites.mockResolvedValue(sampleWrites);
    api.getDnsInventory.mockResolvedValue(sampleInventory);
    api.removeDnsRecords.mockResolvedValue({ runId: "run_removal" });

    // Initial render and load effects
    hooks.cursor = 0;
    evaluate(createElement(Dns));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[1]).toEqual(sampleWrites));

    // Render loaded state
    hooks.cursor = 0;
    let tree = evaluate(createElement(Dns));

    // Tick both checkboxes in the writes table
    const writtenPanel = findElements<{ id?: string }>(tree, (el) => el.props.id === "panel-written")[0]!;
    const checkboxes = findElements<{ type?: string; "aria-label"?: string; onChange?: () => void }>(
      writtenPanel,
      (el) => el.type === "input" && el.props.type === "checkbox" && Boolean(el.props["aria-label"]?.startsWith("Select CNAME")),
    );
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.props.onChange!();
    checkboxes[1]!.props.onChange!();

    // Re-render with ticked checkboxes and click "Remove selected (2)"
    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    const newWrittenPanel = findElements<{ id?: string }>(tree, (el) => el.props.id === "panel-written")[0]!;
    const buttonText = (el: ReactElement<{ children?: ReactNode }>) =>
      Array.isArray(el.props.children) ? el.props.children.join("") : String(el.props.children ?? "");
    const removeBtn = findElements<{ type?: string; className?: string; onClick?: () => void; children?: ReactNode }>(
      newWrittenPanel,
      (el) => el.type === "button" && buttonText(el).startsWith("Remove selected"),
    )[0]!;
    expect(buttonText(removeBtn)).toBe("Remove selected (2)");

    removeBtn.props.onClick!();

    // The in-page ConfirmDialog is now open
    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    const dialogs = findElements<{
      title: string;
      confirmLabel: string;
      destructive?: boolean;
      onCancel: () => void;
      onConfirm: () => void;
      children: ReactNode;
    }>(tree, (el) => el.type === ConfirmDialog);
    expect(dialogs).toHaveLength(1);
    const dialog = dialogs[0]!;

    expect(dialog.props.title).toBe("Remove these 2 records at the DNS provider, in one run?");
    expect(dialog.props.confirmLabel).toBe("Remove");
    expect(dialog.props.destructive).toBe(true);

    const dialogMarkup = renderToStaticMarkup(dialog.props.children as ReactElement);
    expect(dialogMarkup).toContain(recordKey(sampleWrites.rows[0]!));
    expect(dialogMarkup).toContain(recordKey(sampleWrites.rows[1]!));
    expect(dialogMarkup).toContain("cluster1.example.com");
    expect(dialogMarkup).toContain("consumer app1 (prod)");
    expect(dialogMarkup).toContain("consumer app2 (test)");

    // never window.confirm
    expect(confirmSpy).not.toHaveBeenCalled();

    // "Cancel" closes the dialog and calls removeDnsRecords never
    dialog.props.onCancel();
    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    expect(findElements(tree, (el) => el.type === ConfirmDialog)).toHaveLength(0);
    expect(api.removeDnsRecords).not.toHaveBeenCalled();

    // Open dialog again and click "Remove"
    removeBtn.props.onClick!();
    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    const confirmDialog = findElements<{ onConfirm: () => void }>(tree, (el) => el.type === ConfirmDialog)[0]!;
    confirmDialog.props.onConfirm();

    await vi.waitFor(() => {
      expect(api.removeDnsRecords).toHaveBeenCalledTimes(1);
      expect(api.removeDnsRecords).toHaveBeenCalledWith({
        records: [
          { name: "app1.example.com", type: "CNAME" },
          { name: "app2.example.com", type: "CNAME" },
        ],
      });
      expect(nav).toHaveBeenCalledWith("/runs/run_removal");
    });

    // never window.confirm throughout
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("a removal asked from the derived tab reads that tab's rows, and a long value is listed whole", async () => {
    const longKey = `v=DKIM1; k=rsa; p=${"A".repeat(380)}`;
    const inventory: DnsInventoryView = {
      ...sampleInventory,
      rows: [{ ...sampleInventory.rows[0]!, owner: { kind: "tenant", name: "t1", stage: "prod" }, found: longKey }],
    };
    api.getDnsWrites.mockResolvedValue(sampleWrites);
    api.getDnsInventory.mockResolvedValue(inventory);

    hooks.cursor = 0;
    evaluate(createElement(Dns));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[2]).toEqual(inventory));

    hooks.cursor = 0;
    let tree = evaluate(createElement(Dns));
    const derived = () => findElements<{ id?: string }>(tree, (el) => el.props.id === "panel-derived")[0]!;
    const checkbox = findElements<{ type?: string; "aria-label"?: string; onChange?: () => void }>(
      derived(),
      (el) => el.type === "input" && el.props["aria-label"] === "Select CNAME app1.example.com",
    )[0]!;
    checkbox.props.onChange!();

    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    const buttonText = (el: ReactElement<{ children?: ReactNode }>) =>
      Array.isArray(el.props.children) ? el.props.children.join("") : String(el.props.children ?? "");
    const removeBtn = findElements<{ onClick?: () => void; children?: ReactNode }>(
      derived(),
      (el) => el.type === "button" && buttonText(el).startsWith("Remove selected"),
    )[0]!;
    removeBtn.props.onClick!();

    hooks.cursor = 0;
    tree = evaluate(createElement(Dns));
    const dialog = findElements<{ title: string; children: ReactNode }>(tree, (el) => el.type === ConfirmDialog)[0]!;
    expect(dialog.props.title).toBe("Remove this record at the DNS provider, in one run?");
    const markup = renderToStaticMarkup(dialog.props.children as ReactElement);
    expect(markup).toContain(`${longKey} · tenant t1 (prod)`);
    expect(markup).not.toContain("consumer app1");
  });
});
