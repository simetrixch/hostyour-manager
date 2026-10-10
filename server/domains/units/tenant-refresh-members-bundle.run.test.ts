import { describe, it, expect } from "vitest";
import { makeTenantRefreshMembersDef } from "./tenant-refresh-members.run.ts";
import type { Cleanup } from "../../executor/types.ts";
import { GUID, MANIFEST_YAML, OLD, planCtx, planned, ports, seedTenant, staleMembers, stepCtx, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { FakeRepoReader, type FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { tenantVersionParts } from "./tenant-versions.ts";
import { followedVersions } from "./tenant-follow.ts";

// The apps bundle is a part of the tenant like any other: a release moves its stage pin, and the
// tenant's Versions run moves the tenant onto it, with both copies of every app's database list.

useMemoryDb();

const BUNDLE_REPO = TEST_BUNDLE.appsRepo;
const BUNDLE = TEST_BUNDLE.appsImage;
const BUNDLE_OLD = TEST_BUNDLE.appsImageTag;
const BUNDLE_NEW = "0.1.1-stable-20260930120000-bcd2345";
const PINNED = { [`bundles/${BUNDLE}/pins-prod.yaml`]: `builds:\n  - { name: ${BUNDLE}, image: ${BUNDLE}, tag: "${BUNDLE_NEW}" }\n` };
// The engine member reads each app's database list, as a product that lists them declares it.
const MANIFEST = MANIFEST_YAML.replace("engine: { chart: charts/example-engine }", 'engine: { chart: charts/example-engine, values: { databases: { mongodb: { databases: "{databases}" } } } }');

const appsYaml = (databases: string, engineLine?: string): string =>
  `apps:\n  - name: erp\n    title: ERP\n    databases: [${databases}]\n${engineLine ? `engine:\n  build: example-engine\n  line: "${engineLine}"\n` : ""}`;

/** The bundle's two releases: the one the tenant runs lists [core, sales]; the new one adds bikes. */
function withBundleReleases(prt: TenantOnboardPorts, newEngineLine?: string): TenantOnboardPorts {
  const repo = prt.repo as FakeRepoReader;
  repo.scriptFor(`${BUNDLE_REPO}@${BUNDLE_OLD.replace(/-[0-9a-f]{7}$/, "")}`, { files: { "apps.yaml": appsYaml("core, sales") } });
  repo.scriptFor(`${BUNDLE_REPO}@${BUNDLE_NEW.replace(/-[0-9a-f]{7}$/, "")}`, { files: { "apps.yaml": appsYaml("core, sales, bikes", newEngineLine) } });
  return prt;
}

async function bundlePorts(over: { files?: Record<string, string>; newEngineLine?: string } = {}): Promise<TenantOnboardPorts> {
  seedTenant();
  const resolved = await planned(withBundleReleases(ports(staleMembers(), { manifest: MANIFEST })));
  return withBundleReleases(ports(resolved.members, { manifest: MANIFEST, files: over.files ?? PINNED }), over.newEngineLine);
}

const engineDatabases = (members: { name: string; sources: { chart: string; values: Record<string, unknown> }[] }[]): unknown =>
  (members.find((m) => m.name === "erp")!.sources.find((s) => s.chart === "charts/example-engine")!.values["databases"] as { mongodb: { databases: string[] } }).mongodb.databases;

describe("the apps bundle as a part of the tenant", () => {
  it("is a part where its stage pin stands, running the tag the registration holds", async () => {
    const prt = await bundlePorts();
    const entry = (await prt.registrations.readTenant("prod", GUID))!.entry;
    const parts = await tenantVersionParts(prt, "prod", entry.members, entry.approvedTags, entry);
    expect(parts.find((p) => p.name === BUNDLE)).toEqual({ name: BUNDLE, builds: [{ name: BUNDLE, image: BUNDLE, pin: BUNDLE_NEW, released: [BUNDLE_NEW] }], running: [BUNDLE_OLD] });
    expect(followedVersions(parts)[BUNDLE]).toBe(BUNDLE_NEW);
  });

  it("PLANTED INNOCENT: no part where no release pinned the bundle yet, and no move where the tenant runs its pin", async () => {
    const unpinned = await bundlePorts({ files: {} });
    const entry = (await unpinned.registrations.readTenant("prod", GUID))!.entry;
    expect((await tenantVersionParts(unpinned, "prod", entry.members, entry.approvedTags, entry)).map((p) => p.name)).not.toContain(BUNDLE);
    const pinned = withBundleReleases(ports(entry.members, { manifest: MANIFEST, files: PINNED }));
    const parts = await tenantVersionParts(pinned, "prod", entry.members, entry.approvedTags, { ...entry, appsImageTag: BUNDLE_NEW });
    expect(parts.find((p) => p.name === BUNDLE)?.running).toEqual([BUNDLE_NEW]);
    expect(followedVersions(parts)[BUNDLE]).toBeUndefined();
  });

  it("moves the bundle with both database lists and the members in one commit", async () => {
    const prt = await bundlePorts();
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { [BUNDLE]: BUNDLE_NEW } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toContain(`Versions: ${BUNDLE} ${BUNDLE_OLD} → ${BUNDLE_NEW}.`);
    const p = out.params;
    expect(p.appsImageTag).toBe(BUNDLE_NEW);
    const books = (prt.registrations as unknown as { repo: FakePlatformRepo }).repo;
    const before = books.commits.length;
    await makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, [], []));
    expect(books.commits.length - before).toBe(1);
    const after = (await prt.registrations.readTenant("prod", GUID))!.entry;
    expect(after.appsImageTag).toBe(BUNDLE_NEW);
    expect(after.apps.map((a) => [a.name, a.databases])).toEqual([["erp", ["core", "sales", "bikes"]]]);
    expect(engineDatabases(after.members)).toEqual(["core", "sales", "bikes"]);
  });

  it("PLANTED INNOCENT: a Versions run that does not name the bundle leaves it where it stands, though its pin moved on", async () => {
    const prt = await bundlePorts();
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.params.appsImageTag).toBe(BUNDLE_OLD);
    await makeTenantRefreshMembersDef(prt).steps(out.params).find((s) => s.name === "write-members")!.run(stepCtx(out.params, [], []));
    const after = (await prt.registrations.readTenant("prod", GUID))!.entry;
    expect(after.appsImageTag).toBe(BUNDLE_OLD);
    expect(engineDatabases(after.members)).toEqual(["core", "sales"]);
  });

  it("PLANTED DEFECT: refuses a bundle written for another line than the engines the tenant runs", async () => {
    const prt = await bundlePorts({ newEngineLine: "0.2" });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { [BUNDLE]: BUNDLE_NEW } }, planCtx()))
      .rejects.toThrow(`tenant acme cannot run these versions: the apps bundle is written for example-engine 0.2, and erp would run example-engine ${OLD}, of another line`);
  });

  it("an abort after write-members writes the previous bundle, both previous lists and the previous members back", async () => {
    const prt = await bundlePorts();
    const before = (await prt.registrations.readTenant("prod", GUID))!.entry;
    const out = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1", versions: { [BUNDLE]: BUNDLE_NEW } }, planCtx());
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    const p = out.params;
    const cleanups: Cleanup[] = [];
    await makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, cleanups, []));
    await cleanups.find((c) => c.name === "restore-members")!.run(stepCtx(p, [], []));
    const after = (await prt.registrations.readTenant("prod", GUID))!.entry;
    expect(after.appsImageTag).toBe(BUNDLE_OLD);
    expect(after.apps).toEqual(before.apps);
    expect(after.members).toEqual(before.members);
  });
});
