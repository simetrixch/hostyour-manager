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
  planRun: vi.fn(),
  getRun: vi.fn(),
  approveRun: vi.fn(),
  cancelRun: vi.fn(),
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

  /** Load both tabs, tick the written tab's two rows and press "Remove selected (2)". */
  async function pressRemoveOnBothRows(): Promise<void> {
    hooks.cursor = 0;
    evaluate(createElement(Dns));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[1]).toEqual(sampleWrites));
    const written = () => {
      hooks.cursor = 0;
      return findElements<{ id?: string }>(evaluate(createElement(Dns)), (el) => el.props.id === "panel-written")[0]!;
    };
    const checkboxes = findElements<{ type?: string; "aria-label"?: string; onChange?: () => void }>(
      written(),
      (el) => el.type === "input" && el.props.type === "checkbox" && Boolean(el.props["aria-label"]?.startsWith("Select CNAME")),
    );
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.props.onChange!();
    checkboxes[1]!.props.onChange!();
    const removeBtn = findElements<{ onClick?: () => void; children?: ReactNode }>(written(), (el) => el.type === "button" && buttonText(el).startsWith("Remove selected"))[0]!;
    expect(buttonText(removeBtn)).toBe("Remove selected (2)");
    removeBtn.props.onClick!();
  }

  const buttonText = (el: ReactElement<{ children?: ReactNode }>) =>
    Array.isArray(el.props.children) ? el.props.children.join("") : String(el.props.children ?? "");
  const dialogs = () => {
    hooks.cursor = 0;
    return findElements<{ title: string; confirmLabel: string; destructive?: boolean; onCancel: () => void; onConfirm: () => void; children: ReactNode }>(
      evaluate(createElement(Dns)),
      (el) => el.type === ConfirmDialog,
    );
  };
  const RECORDS = [{ name: "app1.example.com", type: "CNAME" }, { name: "app2.example.com", type: "CNAME" }];
  const SUMMARY = "Take back 2 records, one step each; nothing is deleted at the DNS provider: the CNAME record app1.example.com: NOTHING is deleted at the provider";

  it("'Remove selected' plans the run and the dialog shows the plan's own summary and steps; nothing is approved before the confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    api.getDnsWrites.mockResolvedValue(sampleWrites);
    api.getDnsInventory.mockResolvedValue(sampleInventory);
    api.planRun.mockResolvedValue({ runId: "run_removal" });
    api.getRun.mockResolvedValue({ summary: SUMMARY, steps: [{ title: "Attest the 2 records" }, { title: "Take back the CNAME record app1.example.com" }] });
    api.approveRun.mockResolvedValue({});
    await pressRemoveOnBothRows();

    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    expect(api.planRun).toHaveBeenCalledWith("dns-remove", { records: RECORDS });
    expect(api.getRun).toHaveBeenCalledWith("run_removal");
    const dialog = dialogs()[0]!;
    expect(dialog.props.title).toBe("Take back these 2 records, as planned below?");
    expect(dialog.props.confirmLabel).toBe("Approve the removal");
    expect(dialog.props.destructive).toBe(true);
    const markup = renderToStaticMarkup(createElement("div", null, dialog.props.children));
    expect(markup).toContain(SUMMARY);
    expect(markup).toContain("<li>Take back the CNAME record app1.example.com</li>");
    expect(api.approveRun).not.toHaveBeenCalled();

    dialog.props.onConfirm();
    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith("/runs/run_removal"));
    expect(api.approveRun).toHaveBeenCalledWith("run_removal");
    expect(api.cancelRun).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Cancel cancels the planned run and approves nothing", async () => {
    api.getDnsWrites.mockResolvedValue(sampleWrites);
    api.getDnsInventory.mockResolvedValue(sampleInventory);
    api.planRun.mockResolvedValue({ runId: "run_removal" });
    api.getRun.mockResolvedValue({ summary: SUMMARY, steps: [] });
    api.cancelRun.mockResolvedValue({});
    await pressRemoveOnBothRows();
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));

    dialogs()[0]!.props.onCancel();
    await vi.waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith("run_removal"));
    expect(api.approveRun).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
  });

  it("a refused plan shows its sentence, opens no dialog and approves nothing", async () => {
    api.getDnsWrites.mockResolvedValue(sampleWrites);
    api.getDnsInventory.mockResolvedValue(sampleInventory);
    api.planRun.mockRejectedValue(new Error("1 of the 2 record(s) cannot be taken back, so none is"));
    await pressRemoveOnBothRows();

    await vi.waitFor(() => expect(hooks.states[3]).toBe("1 of the 2 record(s) cannot be taken back, so none is"));
    expect(dialogs()).toHaveLength(0);
    expect(api.getRun).not.toHaveBeenCalled();
    expect(api.approveRun).not.toHaveBeenCalled();
  });
});
