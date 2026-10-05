import { describe, expect, it } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnitSizeView } from "#core/web/api.ts";
import { SIZE_COMPONENT, UNIT_SIZE_LETTER, UNIT_SIZE_SEED } from "../../shared/unit-size.ts";
import { SizeTables, type SizeDraft } from "./UnitSizes.tsx";

// The seed's rows, as the page fetches them: 3 + 3 + 3 + 6.
const rows: UnitSizeView[] = SIZE_COMPONENT.flatMap((component) => Object.entries(UNIT_SIZE_SEED[component]).map(([name, q]) => ({
  component, name: name as UnitSizeView["name"],
  requestsCpu: q!.requestsCpu, requestsMemory: q!.requestsMemory, limitsCpu: q!.limitsCpu, limitsMemory: q!.limitsMemory,
  pods: q!.pods, persistentVolumeClaims: q!.persistentVolumeClaims,
})));
const draft = (of: readonly UnitSizeView[]): Record<string, SizeDraft> => Object.fromEntries(of.map((s) => [`${s.component}/${s.name}`, {
  requestsCpu: s.requestsCpu, requestsMemory: s.requestsMemory, limitsCpu: s.limitsCpu, limitsMemory: s.limitsMemory, pods: String(s.pods), persistentVolumeClaims: String(s.persistentVolumeClaims),
}]));
const render = (of: readonly UnitSizeView[]) => renderToStaticMarkup(createElement(SizeTables, { rows: of, draft: draft(of), saving: null, saved: null, onEdit: () => undefined, onSave: () => undefined }));
const PART: Record<string, string> = { member: "tenant app", base: "Application", postgresql: "+ own PostgreSQL", mongodb: "+ own MongoDB, per member", redis: "+ own Redis", mariadb: "+ own MariaDB" };
const FIGURE: Record<string, string> = { requestsCpu: "requests.cpu", requestsMemory: "requests.memory", limitsCpu: "limits.cpu", limitsMemory: "limits.memory", pods: "pods", persistentVolumeClaims: "PVCs" };
type Handlers = { label?: string; onChange?: (v: string) => void; onClick?: () => void };

/** Every element of the tree that takes an edit or a click, with its props. */
function walk(node: ReactNode, out: Handlers[]): void {
  if (Array.isArray(node)) { node.forEach((n: ReactNode) => walk(n, out)); return; }
  if (!isValidElement(node)) return;
  const p = node.props as Handlers & { children?: ReactNode };
  if (typeof p.onChange === "function" || typeof p.onClick === "function") out.push(p);
  walk(p.children, out);
}

describe("SizeTables", () => {
  it("shows a tenant table and a consumer table, each figure once, in the operator's words", () => {
    expect(rows).toHaveLength(36);
    const html = render(rows);
    expect(html.match(/<table/g)).toHaveLength(2);
    expect([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual(["Tenant (per app)", "Consumer"]);
    const [tenant, consumer] = html.split("<table").slice(1);
    expect(tenant!.match(/<tbody>.*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(6);
    expect(consumer!.match(/<tbody>.*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(6);
    // Six inputs per row and part: 6 tenant rows, 6 consumer rows of five parts each.
    expect(html.match(/<input/g)).toHaveLength(6 * 6 + 6 * 5 * 6);
    expect(html.match(/>Save</g)).toHaveLength(6 + 30);
    expect(html).toContain("XL (not offered)");
    expect(html).not.toMatch(/>(base|member|postgresql|mongodb|redis|mariadb)</);
  });

  it("wires each input to its own component, size and figure, and each Save to its own row", () => {
    const edits: string[] = []; const saves: string[] = [];
    const tree = SizeTables({ rows, draft: {}, saving: null, saved: null, onEdit: (k, f) => edits.push(`${k}|${f}`), onSave: (s) => saves.push(`${s.component}/${s.name}`) });
    const handlers: Handlers[] = []; walk(tree, handlers);
    for (const p of handlers.filter((h) => h.onChange)) {
      const before = edits.length; p.onChange!("1");
      const [key, field] = edits[before]!.split("|");
      const [component, name] = key!.split("/");
      expect(p.label).toBe(`${UNIT_SIZE_LETTER[name as UnitSizeView["name"]]} ${PART[component!]} ${FIGURE[field!]}`);
    }
    for (const p of handlers.filter((h) => h.onClick)) p.onClick!();
    expect(new Set(edits).size).toBe(216);
    expect(edits).toHaveLength(216);
    expect([...saves].sort()).toEqual(rows.map((s) => `${s.component}/${s.name}`).sort());
  });
});
