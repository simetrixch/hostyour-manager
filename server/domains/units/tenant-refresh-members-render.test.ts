import { describe, it, expect } from "vitest";
import { rendersEntry } from "./tenant-refresh-members.run.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { DEPLOY_URL, SHA } from "./tenant-refresh-members.fixture.ts";

describe("rendersEntry, clause by clause", () => {
  const src = (over: Partial<TenantMemberRecord["sources"][number]> = {}): TenantMemberRecord["sources"][number] => ({ chart: "charts/x", valueFiles: [], values: {}, ...over });
  const entry = (over: Partial<TenantMemberRecord> = {}): TenantMemberRecord => ({ name: "erp", path: "/app/erp", namespaceLabels: {}, sources: [src()], ...over });
  const render = (m: TenantMemberRecord, labels: Record<string, string> = {}): ArgoAppStatus => ({
    syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", namespaceLabels: { "platform/tenant-stage": "prod", ...labels },
    syncSources: m.sources.map((s) => ({ repoURL: DEPLOY_URL, revision: SHA, path: s.chart, valueFiles: ["values.yaml", ...s.valueFiles], valuesObject: { tenant: {}, ...s.values } })),
  });
  it("holds the entry's value files in their order, searched after the template's own", () => {
    const want = entry({ sources: [src({ valueFiles: ["a.yaml", "values.yaml"] })] });
    expect(rendersEntry(render(want), want, undefined, DEPLOY_URL, "prod")).toBe(true);
    expect(rendersEntry(render(entry({ sources: [src({ valueFiles: ["b.yaml", "a.yaml"] })] })), entry({ sources: [src({ valueFiles: ["a.yaml", "b.yaml"] })] }), undefined, DEPLOY_URL, "prod")).toBe(false);
    expect(rendersEntry(render(entry({ sources: [src({ valueFiles: ["values.yaml", "a.yaml"] })] })), entry({ sources: [src({ valueFiles: ["values.yaml", "a.yaml"] })] }), undefined, DEPLOY_URL, "prod")).toBe(true);
  });
  it("refuses a value file the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ valueFiles: ["old.yaml"] })] });
    expect(rendersEntry(render(was), entry(), was, DEPLOY_URL, "prod")).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, DEPLOY_URL, "prod")).toBe(true);
  });
  it("refuses a value key the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ values: { debug: true } })] });
    expect(rendersEntry(render(was), entry(), was, DEPLOY_URL, "prod")).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, DEPLOY_URL, "prod")).toBe(true);
  });
  it("refuses a namespace label the previous entry had and the new one dropped, and a label of another value", () => {
    const was = entry({ namespaceLabels: { stale: "yes" } });
    expect(rendersEntry(render(entry(), { stale: "yes" }), entry(), was, DEPLOY_URL, "prod")).toBe(false);
    expect(rendersEntry(render(entry(), {}), entry(), was, DEPLOY_URL, "prod")).toBe(true);
    const want = entry({ namespaceLabels: { tier: "b" } });
    expect(rendersEntry(render(want, { tier: "a" }), want, undefined, DEPLOY_URL, "prod")).toBe(false);
  });
  it("uses the registration stage when a member declares or drops the platform stage label", () => {
    for (const stage of ["dev", "test", "prod"] as const) {
      const want = entry({ namespaceLabels: { "platform/tenant-stage": "foreign" } });
      const correct = { ...render(want), namespaceLabels: { "platform/tenant-stage": stage } };
      expect(rendersEntry(correct, want, undefined, DEPLOY_URL, stage)).toBe(true);
      expect(rendersEntry(correct, entry(), want, DEPLOY_URL, stage)).toBe(true);
      expect(rendersEntry({ ...correct, namespaceLabels: { "platform/tenant-stage": "foreign" } }, want, undefined, DEPLOY_URL, stage)).toBe(false);
      expect(rendersEntry({ ...correct, namespaceLabels: {} }, entry(), undefined, DEPLOY_URL, stage)).toBe(false);
    }
  });
});
