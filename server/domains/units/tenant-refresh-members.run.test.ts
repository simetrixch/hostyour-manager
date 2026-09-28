import { describe, it, expect } from "vitest";
import { tenants } from "../../db/schema/inventory.ts";
import { makeTenantRefreshMembersDef, rendersEntry, TenantRefreshMembersParams } from "./tenant-refresh-members.run.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import type { Cleanup } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { buildUnitStepName } from "./tenant-builds.ts";
import { DEPLOY_URL, GUID, HELD, HeldImagesGoneArgo, MANIFEST_YAML, NEW, OLD, OLDER, RELEASED, RELEASED_BEFORE, SHA, db, planCtx, planned, ports, rendering, resolved, seedTenant, staleMembers, stepCtx, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";

// tenant-refresh-members: the plan resolves the members again off the product's manifest and names
// what changes, refuses a tenant with nothing to change or a changed member set, and the steps write
// the entries and wait for the sync; an abort writes the previous entries back.
// Their helpers are in the fixture module of the same name.

useMemoryDb();

describe("tenant-refresh-members", () => {
  it("resolves a renamed chart, writes every member entry and waits for every member to sync", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const logs: string[] = [];
    for (const step of makeTenantRefreshMembersDef(prt).steps(p)) await step.run(stepCtx(p, [], logs));
    const erp = (await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp");
    expect(erp?.sources[1]?.chart).toBe("charts/example-ui");
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  it("an abort writes the previous member entries back", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const cleanups: Cleanup[] = [];
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    await write.run(stepCtx(p, cleanups, []));
    for (const c of cleanups.reverse()) await c.run(stepCtx(p, [], []));
    const erp = (await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp");
    expect(erp?.sources[1]?.chart).toBe("charts/old-ui");
  });

  it("plans a tenant whose entries already match the manifest as current: nothing to do is no error", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const out = await makeTenantRefreshMembersDef(ports(resolved.members)).planStream!({ tenantId: "tnt_1" }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toMatch(/nothing changes — every member entry matches the product's manifest and every part runs the version asked for/);
  });

  it("puts a part on the version chosen, starts a build the tenant lacks at its pin, waits until every member renders them, and an abort writes the previous ones back", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const want = { erp: { "example-engine": NEW }, auth: { "example-auth": NEW } };
    const prt = ports(resolved.members, { files: RELEASED, argo: [() => rendering(resolved.members), () => rendering(resolved.members, want)] });
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEW } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toContain(`Versions: example-platform ${OLD} → ${NEW}. Recorded as the tenant's own at the stage pin it renders now: auth/example-auth ${NEW}. No other tenant changes.`);
    expect(out.params.chosenVersions).toEqual({ "example-engine": NEW });
    const p = out.params;
    const steps = makeTenantRefreshMembersDef(prt).steps(p);
    const cleanups: Cleanup[] = [];
    await steps.find((s) => s.name === "write-versions")!.run(stepCtx(p, cleanups, []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual(want);
    expect(db.db.select({ a: tenants.approvedTags }).from(tenants).get()?.a).toEqual(want);
    const watch = steps.find((s) => s.name === "watch-versions")!;
    await expect(watch.run(stepCtx(p, [], []))).rejects.toThrow(/has not rendered their versions yet/);
    await expect(watch.run(stepCtx(p, [], []))).resolves.toBeUndefined();
    await cleanups[0]!.run(stepCtx(p, [], []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual({ erp: { "example-engine": OLD } });
  });

  // The bundle the tenant runs is read off its own repository at the release it was built from, where a
  // version moves a line, and the engines a run puts the tenant on have to be of the line that bundle
  // declares (engine-line.ts). NEXT_LINE is a release of the engine on the line after the one held.
  const BUNDLE_REPO = "https://github.com/acme-org/example-apps-acme.git";
  const NEXT_LINE = "0.2.000-stable-20260927120000-1234abc";
  const RELEASED_NEXT_LINE = { "charts/example-engine/pins-prod.yaml": `builds:\n  - { name: example-engine, image: example-engine, tag: "${NEXT_LINE}" }\n` };
  const bundleWith = (prt: TenantOnboardPorts, line: string): TenantOnboardPorts => {
    (prt.repo as FakeRepoReader).scriptFor(BUNDLE_REPO, { resolvedSha: SHA, files: { "apps.yaml": `apps:\n  - name: erp\n    title: ERP\nengine:\n  build: example-engine\n  line: "${line}"\n` } });
    return prt;
  };
  const bundleClones = (prt: TenantOnboardPorts): string[] => (prt.repo as FakeRepoReader).clones.filter((c) => c.repoURL === BUNDLE_REPO).map((c) => c.ref);

  it("reads the running bundle off its own release where a version moves a line, and plans versions of the bundle's line", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const prt = bundleWith(ports(resolved.members, { files: RELEASED_NEXT_LINE }), "0.2");
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEXT_LINE } }, planCtx());
    expect(out.outcome).toBe("planned");
    expect(bundleClones(prt)).toEqual(["0.1.0-stable-20260101000000"]);
  });

  it("PLANTED DEFECT: refuses a version that moves the tenant's engine off the line of its bundle", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const prt = bundleWith(ports(resolved.members, { files: RELEASED_NEXT_LINE }), "0.1");
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEXT_LINE } }, planCtx()))
      .rejects.toThrow(`tenant acme cannot run these versions: the apps bundle is written for example-engine 0.1, and erp would run example-engine ${NEXT_LINE}, of another line`);
  });

  it("keeps every line without reading the tenant's own repository at all", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const prt = bundleWith(ports(resolved.members, { files: { "charts/example-engine/pins-prod.yaml": RELEASED["charts/example-engine/pins-prod.yaml"]! } }), "0.2");
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEW } }, planCtx());
    expect(out.outcome).toBe("planned");
    expect(bundleClones(prt)).toEqual([]);
  });

  it("PLANTED DEFECT: write-versions judges the versions as it writes them, and writes none off the bundle's line", async () => {
    seedTenant();
    const p = { ...(await planned(ports(staleMembers()))), chosenVersions: { "example-engine": NEXT_LINE } };
    const prt = bundleWith(ports(p.members, { files: RELEASED_NEXT_LINE }), "0.1");
    await expect(makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-versions")!.run(stepCtx(p, [], [])))
      .rejects.toThrow(`tenant ${GUID} cannot run these versions: the apps bundle is written for example-engine 0.1, and erp would run example-engine ${NEXT_LINE}, of another line`);
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual(HELD);
  });

  it("moves a tenant whose held images are gone onto the versions chosen: the versions are written before any wait", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const prt = ports(resolved.members, { files: RELEASED, argoReader: (tenantRegistrations) => new HeldImagesGoneArgo(tenantRegistrations, resolved.members) });
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEW } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    const p = out.params;
    for (const step of makeTenantRefreshMembersDef(prt).steps(p)) await step.run(stepCtx(p, [], []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual({ erp: { "example-engine": NEW }, auth: { "example-auth": NEW } });
  });

  it("says a downgrade where a part is put on a version older than the one it runs, and what a downgrade does not move back", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const out = await makeTenantRefreshMembersDef(ports(resolved.members, { files: RELEASED, earlier: RELEASED_BEFORE })).planStream!({ tenantId: "tnt_1", versions: { "example-platform": OLDER } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toContain(`Downgrade: example-platform ${OLD} → ${OLDER}, older than what runs now. `);
    expect(out.plan.warnings).toEqual([`downgrade: example-platform ${OLD} → ${OLDER} — only the images move back; a database the newer version migrated stays migrated, and the older version must run on it`]);
    expect(out.params.chosenVersions).toEqual({ "example-engine": OLDER });
    expect(out.params.previousApproved).toEqual(HELD);
  });

  it("REFUSES a part the tenant does not have, a version that is no image tag, a channel the stage does not take, a version no release made available at the stage, and one the registry lacks", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const plan = (versions: Record<string, string>, missing: string[] = []) =>
      makeTenantRefreshMembersDef(ports(resolved.members, { files: RELEASED, earlier: RELEASED_BEFORE, missing })).planStream!({ tenantId: "tnt_1", versions }, planCtx());
    await expect(plan({ nope: NEW })).rejects.toThrow(/tenant acme has no part "nope" — its parts are example-auth, example-platform/);
    await expect(plan({ "example-platform": "0.1.10" })).rejects.toThrow(/an image tag <x\.y\.z>-<channel>-<ts14>-<sha7>/);
    await expect(plan({ "example-platform": "0.1.12-beta-20260924120000-7654321" })).rejects.toThrow(/the beta channel reaches dev, test \(global\.channelStages\), not prod/);
    await expect(plan({ "example-platform": "0.1.13-stable-20260926120000-1234567" })).rejects.toThrow(/no release made 0\.1\.13-stable-20260926120000-1234567 available at prod: the stage pin of example-engine never named it/);
    await expect(plan({ "example-platform": OLDER }, [`example-engine:${OLDER}`])).rejects.toThrow(new RegExp(`zot\\.m1\\.example/example-engine:${OLDER} is not in the registry`));
  });

  it("keeps every part the request does not name where it runs, though its stage pin moved on", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const out = await makeTenantRefreshMembersDef(ports(resolved.members, { files: RELEASED })).planStream!({ tenantId: "tnt_1" }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).not.toContain("Versions:");
    expect(out.params.chosenVersions).toEqual({});
    const p = out.params;
    await makeTenantRefreshMembersDef(ports(resolved.members, { files: RELEASED })).steps(p).find((s) => s.name === "write-versions")!.run(stepCtx(p, [], []));
    expect(db.db.select({ a: tenants.approvedTags }).from(tenants).get()?.a).toEqual({ erp: { "example-engine": OLD }, auth: { "example-auth": NEW } });
  });

  it("allows the abort of a run that changes no entry, though every member renders it: only its versions go back", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    const prt = ports(resolved.members, { files: RELEASED, argo: [() => rendering(resolved.members)] });
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { "example-platform": NEW } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    await expect(makeTenantRefreshMembersDef(prt).assertAbortable!(out.params, { db: db.db })).resolves.toBeUndefined();
  });

  it("REFUSES a manifest that changes the member set: that is a new namespace and Application", async () => {
    seedTenant();
    const fewer = staleMembers().filter((m) => m.name !== "report");
    await expect(makeTenantRefreshMembersDef(ports(fewer)).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/not a refresh/);
  });

  it("carries the deploy trunk into the books branch before it resolves anything", async () => {
    seedTenant();
    const carried: string[] = [];
    await planned(ports(staleMembers(), { carried }));
    expect(carried).toEqual(["carried"]);
  });

  it("REFUSES a manifest that moves the identity provider, and a suspended tenant", async () => {
    seedTenant();
    const moved = staleMembers();
    const prt = ports(moved);
    const entry = (await prt.registrations.readTenant("prod", GUID))!.entry;
    await prt.registrations.commitTenant({ stage: "prod", guid: GUID, runId: "run_x", registration: { ...entry, identityProvider: "jobs" } });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/moving the identity provider/);
    db.db.update(tenants).set({ suspended: true }).run();
    await expect(makeTenantRefreshMembersDef(ports(staleMembers())).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/suspended/);
  });

  it("builds a missing image the product's buildRepos names ahead of ensure-images, and refuses one nobody builds", async () => {
    seedTenant();
    const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
    const withRepos = ports(staleMembers(), { missing: ["example-app:1.0.0"], manifest: MANIFEST_YAML.replace("  members:", `  buildRepos:
    - repo: ${PLATFORM_REPO}
      builds: [example-app]
  members:`) });
    const p = await planned(withRepos);
    expect(p.buildUnits).toEqual([{ unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-app"], registered: false }]);
    const names = makeTenantRefreshMembersDef(withRepos).steps(p).map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBe(1);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBeLessThan(names.indexOf("ensure-images"));
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("write-members"));
    const nobody = await makeTenantRefreshMembersDef(ports(staleMembers(), { missing: ["example-app:1.0.0"] })).planStream!({ tenantId: "tnt_1" }, planCtx());
    expect(nobody.outcome).toBe("rejected");
    if (nobody.outcome === "rejected") expect(nobody.summary).toMatch(/buildRepos names no repository.*example-app:1\.0\.0/);
  });

  it("does not take a member Synced + Healthy on its old entry for one that rendered the new entry", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [() => rendering(staleMembers())] });
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(watch.run(stepCtx(p, [], []))).rejects.toThrow(/auth, erp are Synced \+ Healthy but ArgoCD has not rendered the new entries yet/);
  });

  it("does not take a render whose values or namespace labels still differ from the new entry", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [() => rendering(resolved.map((m) => (m.name === "auth" ? { ...m, namespaceLabels: {} } : m)))] });
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(watch.run(stepCtx(p, [], []))).rejects.toThrow(/auth is Synced/);
  });

  it("refuses a render that still carries a dropped value file and value or lacks a chart, and takes one with an extra value or label nobody named", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    const erpAt = p.members.findIndex((m) => m.name === "erp");
    const withErp = (erp: TenantMemberRecord): (() => Map<string, ArgoAppStatus>) => () => rendering(p.members.map((m, i) => (i === erpAt ? erp : m)));
    const erp = p.members[erpAt]!;
    const was = p.previous.find((m) => m.name === "erp")!;
    // The previous erp engine carried a value file and a value the new entry drops: still rendered, not synced.
    const stale = { ...erp, sources: [{ ...erp.sources[0]!, valueFiles: was.sources[0]!.valueFiles, values: was.sources[0]!.values }, erp.sources[1]!] };
    const cases: TenantMemberRecord[] = [
      stale,
      { ...erp, sources: [{ ...erp.sources[0]!, values: { ...erp.sources[0]!.values, extra: 1 } }, erp.sources[1]!] }, // extra is harmless only when neither side named it
      { ...erp, sources: [erp.sources[0]!] },
      { ...erp, namespaceLabels: { ...erp.namespaceLabels, gone: "yes" } },
    ];
    const verdicts: boolean[] = [];
    for (const c of cases) {
      const run = makeTenantRefreshMembersDef(ports(staleMembers(), { argo: [withErp(c)] })).steps(p).find((s) => s.name === "watch-sync-set")!;
      verdicts.push(await run.run(stepCtx(p, [], [])).then(() => true, () => false));
    }
    expect(verdicts).toEqual([false, true, false, true]);
    await expect(watch.run(stepCtx(p, [], []))).resolves.toBeUndefined();
  });

  it("write-members resumed after its own write commits nothing new, keeps its cleanup and stamps the tenant row", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    const cleanups: Cleanup[] = [];
    await write.run(stepCtx(p, cleanups, []));
    await write.run(stepCtx(p, cleanups, []));
    expect(cleanups.map((c) => c.name)).toEqual(["restore-members", "restore-members"]);
    expect(db.db.select({ r: tenants.lastRunId }).from(tenants).get()?.r).toBe("run_refresh");
  });

  it("fails the plan when the deploy trunk cannot be carried: it never plans over a stale books branch", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { carry: async () => { throw new Error("push rejected"); } });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/push rejected/);
  });

  it("REFUSES the abort once every member renders the new entries; the restore leaves entries another run wrote", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const def = makeTenantRefreshMembersDef(prt);
    const cleanups: Cleanup[] = [];
    await def.steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, cleanups, []));
    await expect(def.assertAbortable!(p, { db: db.db })).rejects.toThrow(/Retry the failed step/);
    const other = p.members.map((m) => (m.name === "erp" ? { ...m, namespaceLabels: { later: "yes" } } : m));
    await prt.registrations.setMembers("prod", GUID, other, "run_other");
    await cleanups[0]!.run(stepCtx(p, [], []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp")?.namespaceLabels).toEqual({ later: "yes" });
  });

  it("allows the abort while the members have not converged", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [() => rendering(staleMembers())] });
    const p = await planned(prt);
    const def = makeTenantRefreshMembersDef(prt);
    await def.steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, [], []));
    await expect(def.assertAbortable!(p, { db: db.db })).resolves.toBeUndefined();
  });

  it("the write asks the plan's facts again: entries changed since the plan fail without writing", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const other = staleMembers().map((m) => (m.name === "erp" ? { ...m, namespaceLabels: { moved: "yes" } } : m));
    await prt.registrations.setMembers("prod", GUID, other, "run_other");
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    await expect(write.run(stepCtx(p, [], []))).rejects.toThrow(/changed since this run was planned/);
  });
});

describe("the Versions run's params", () => {
  it("keep a website's folder, site and domain, so the render after the builds finds the website's folder", () => {
    const website = { name: "example-ch", folder: "web", site: "main", domain: "example.ch", seedReference: false, seedDemo: false, selections: {} };
    const erp = { name: "erp", seedReference: true, seedDemo: false, selections: {} };
    expect(TenantRefreshMembersParams.shape.apps.parse([erp, website])).toEqual([erp, website]);
  });
});

describe("rendersEntry, clause by clause", () => {
  const src = (over: Partial<TenantMemberRecord["sources"][number]> = {}): TenantMemberRecord["sources"][number] => ({ chart: "charts/x", valueFiles: [], values: {}, ...over });
  const entry = (over: Partial<TenantMemberRecord> = {}): TenantMemberRecord => ({ name: "erp", namespaceLabels: {}, sources: [src()], ...over });
  const render = (m: TenantMemberRecord, labels: Record<string, string> = {}): ArgoAppStatus => ({
    syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", namespaceLabels: labels,
    syncSources: m.sources.map((s) => ({ repoURL: DEPLOY_URL, revision: SHA, path: s.chart, valueFiles: ["values.yaml", ...s.valueFiles], valuesObject: { tenant: {}, ...s.values } })),
  });
  it("holds the entry's value files in their order, searched after the template's own", () => {
    const want = entry({ sources: [src({ valueFiles: ["a.yaml", "values.yaml"] })] });
    expect(rendersEntry(render(want), want, undefined, DEPLOY_URL)).toBe(true);
    const swapped = entry({ sources: [src({ valueFiles: ["values.yaml", "a.yaml"] })] });
    expect(rendersEntry(render(entry({ sources: [src({ valueFiles: ["b.yaml", "a.yaml"] })] })), entry({ sources: [src({ valueFiles: ["a.yaml", "b.yaml"] })] }), undefined, DEPLOY_URL)).toBe(false);
    expect(rendersEntry(render(swapped), swapped, undefined, DEPLOY_URL)).toBe(true);
  });
  it("refuses a value file the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ valueFiles: ["old.yaml"] })] });
    expect(rendersEntry(render(was), entry(), was, DEPLOY_URL)).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, DEPLOY_URL)).toBe(true);
  });
  it("refuses a value key the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ values: { debug: true } })] });
    expect(rendersEntry(render(was), entry(), was, DEPLOY_URL)).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, DEPLOY_URL)).toBe(true);
  });
  it("refuses a namespace label the previous entry had and the new one dropped, and a label of another value", () => {
    const was = entry({ namespaceLabels: { stale: "yes" } });
    expect(rendersEntry(render(entry(), { stale: "yes" }), entry(), was, DEPLOY_URL)).toBe(false);
    expect(rendersEntry(render(entry(), {}), entry(), was, DEPLOY_URL)).toBe(true);
    const want = entry({ namespaceLabels: { tier: "b" } });
    expect(rendersEntry(render(want, { tier: "a" }), want, undefined, DEPLOY_URL)).toBe(false);
  });
});
