import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailDnsView } from "../../../shared/mail.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));
const api = vi.hoisted(() => ({
  getMailDns: vi.fn(),
  publishMailDns: vi.fn(),
  publishEnvelopeSpf: vi.fn(),
  publishPlatformDkim: vi.fn(),
  publishMailDmarc: vi.fn(),
  unpublishMailDns: vi.fn(),
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
}));
vi.mock("../api.ts", () => api);

const { Mail } = await import("./Mail.tsx");

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

const sampleMailDns: MailDnsView = {
  master: { serverId: "srv_master", name: "master1", fqdn: "master1.example.com", stage: "prod" },
  sender: { unit: "mail-sender", cluster: "cls_1" },
  egress: { name: "mail.example.com", address: "192.0.2.1" },
  domains: [
    {
      domain: "mail.example.com",
      role: "alert mail",
      publishRefusal: null,
      rows: [
        { record: "spf", name: "mail.example.com", expected: "v=spf1 a -all", found: "v=spf1 a -all", ok: true },
        { record: "dkim", name: "prod._domainkey.mail.example.com", expected: "v=DKIM1...", found: "v=DKIM1...", ok: true },
        { record: "dmarc", name: "_dmarc.mail.example.com", expected: "v=DMARC1; p=none", found: "v=DMARC1; p=none; rua=mailto:dmarc@example.com", ok: true },
      ],
    },
  ],
  formerDmarc: [],
  measuredAt: "2026-10-07T12:00:00Z",
};

describe("Mail page in-page unpublish confirmation", () => {
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

  it("'Unpublish <domain>' opens ConfirmDialog; Cancel plans nothing; confirm calls unpublishMailDns(domain)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    api.getMailDns.mockResolvedValue(sampleMailDns);
    api.unpublishMailDns.mockResolvedValue({ runId: "run_unpublish_1" });

    // Initial render and effect execution
    hooks.cursor = 0;
    evaluate(createElement(Mail));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual(sampleMailDns));

    // Render loaded state
    hooks.cursor = 0;
    let tree = evaluate(createElement(Mail));

    const buttonText = (el: ReactElement<{ children?: ReactNode }>) =>
      Array.isArray(el.props.children) ? el.props.children.join("") : String(el.props.children ?? "");

    const unpublishBtn = findElements<{ type?: string; className?: string; onClick?: () => void; children?: ReactNode }>(
      tree,
      (el) => el.type === "button" && buttonText(el) === "Unpublish mail.example.com",
    )[0]!;
    expect(unpublishBtn).toBeDefined();

    // Click "Unpublish mail.example.com"
    unpublishBtn.props.onClick!();

    // The in-page ConfirmDialog is now open
    hooks.cursor = 0;
    tree = evaluate(createElement(Mail));
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

    expect(dialog.props.title).toBe("Unpublish the mail DNS of mail.example.com?");
    expect(dialog.props.confirmLabel).toBe("Unpublish mail.example.com");
    expect(dialog.props.destructive).toBe(true);

    const dialogMarkup = renderToStaticMarkup(dialog.props.children as ReactElement);
    expect(dialogMarkup).toContain("Mail sent as this domain fails the checks receivers make the moment the SPF, DKIM and DMARC records are gone.");

    // never window.confirm
    expect(confirmSpy).not.toHaveBeenCalled();

    // Cancel plans nothing
    dialog.props.onCancel();
    hooks.cursor = 0;
    tree = evaluate(createElement(Mail));
    expect(findElements(tree, (el) => el.type === ConfirmDialog)).toHaveLength(0);
    expect(api.unpublishMailDns).not.toHaveBeenCalled();

    // Open dialog again and click Confirm
    hooks.cursor = 0;
    const freshTree = evaluate(createElement(Mail));
    const freshUnpublishBtn = findElements<{ type?: string; onClick?: () => void; children?: ReactNode }>(
      freshTree,
      (el) => el.type === "button" && buttonText(el) === "Unpublish mail.example.com",
    )[0]!;
    freshUnpublishBtn.props.onClick!();

    hooks.cursor = 0;
    tree = evaluate(createElement(Mail));
    const confirmDialog = findElements<{ onConfirm: () => void }>(tree, (el) => el.type === ConfirmDialog)[0]!;
    confirmDialog.props.onConfirm();

    await vi.waitFor(() => {
      expect(api.unpublishMailDns).toHaveBeenCalledTimes(1);
      expect(api.unpublishMailDns).toHaveBeenCalledWith("mail.example.com");
      expect(nav).toHaveBeenCalledWith("/runs/run_unpublish_1");
    });

    // never window.confirm throughout
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
