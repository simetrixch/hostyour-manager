import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnitSizeView } from "#core/web/api.ts";
import { SIZE_COMPONENT, UNIT_SIZE_SEED } from "../../shared/unit-size.ts";
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

describe("SizeTables", () => {
  it("shows a tenant table and a consumer table, each figure once, in the operator's words", () => {
    expect(rows).toHaveLength(15);
    const html = render(rows);
    expect(html.match(/<table/g)).toHaveLength(2);
    expect([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual(["Tenant (per app)", "Consumer"]);
    const [tenant, consumer] = html.split("<table").slice(1);
    expect(tenant!.match(/<tbody>.*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(6);
    expect(consumer!.match(/<tbody>.*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(3);
    // Six inputs per row and part: 6 tenant rows, 3 consumer rows of three parts each.
    expect(html.match(/<input/g)).toHaveLength(6 * 6 + 3 * 3 * 6);
    expect(html.match(/>Save</g)).toHaveLength(6 + 9);
    expect(html).toContain("XL (not offered)");
    expect(html).not.toMatch(/>(base|member|postgresql|mongodb)</);
  });
});
