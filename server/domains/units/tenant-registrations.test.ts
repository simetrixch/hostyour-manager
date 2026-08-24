import { describe, it, expect } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { Stage } from "../../../shared/enums.ts";
import { testMembers } from "./tenant-members.fixture.ts";

const GUID = "zsjs023ctne0"; // a live guid (matches the registrations/** path guard)
const DIR = `registrations/${GUID}`;

function registration(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1",
    members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]),
    identityProvider: "auth",
    subdomain: "simetrix.dev",
    apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    ...over,
  };
}

/** A cluster-marking resolver that answers from a literal name -> stage map. Stands in for the maps
 *  under clusters/active/ so a boundary test states BOTH sides in one place. */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}

const CLUSTERS = marked({ s1: "dev", s2: "dev" });

describe("tenantRegistrationWrite (the ONE-file write the tenant appsets read)", () => {
  it("writes registrations/<guid>/<stage>.yaml carrying every field the schema defaults", () => {
    const w = tenantRegistrationWrite("dev", GUID, registration());
    expect(w.path).toBe(`${DIR}/dev.yaml`);
    expect(w.content).toContain('cluster: "s1"'); // the appset destination + AppProject pin
    expect(w.content).toContain('subdomain: "simetrix.dev"');
    expect(w.content).toContain('apps: [{"name":"erp","seedReference":false,"seedDemo":false}]'); // both tiers default false, round-trip in-file
    expect(w.content).toContain("seedUsers: false");
    expect(w.content).toContain('resetNonce: "1"');
    expect(w.content).toContain("suspended: false");
    expect(w.content).toContain("quiesced: false");
    // no guid/stage/chartsRef in the body — the path IS the identity
    expect(w.content).not.toContain("guid");
    expect(w.content).not.toContain("chartsRef");
  });

  it("serializes both per-app seed tiers into apps[] (mixed reference/demo)", () => {
    // seedReference + seedDemo are always emitted per app (JSON in the flat apps[] value) —
    // true when the operator toggled that tier, false by default. A mix round-trips so the appset can
    // read each tier per app.
    const w = tenantRegistrationWrite("dev", GUID, registration({ apps: [{ name: "erp", seedReference: true, seedDemo: false }, { name: "web", seedReference: false, seedDemo: true }], members: testMembers(["erp", "web"]) }));
    expect(w.content).toContain('apps: [{"name":"erp","seedReference":true,"seedDemo":false},{"name":"web","seedReference":false,"seedDemo":true}]');
  });
});

describe("TenantRegistrations", () => {
  it("commits the ONE registration file in one commit with a run-id trailer", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    expect(repo.commits).toHaveLength(1);
    const c = repo.commits[0]!;
    expect(c.branch).toBe(repo.booksBranch); // the books branch, never the trunk the charts stand on
    expect(c.message).toBe(`create-tenant(${GUID}): dev on s1 + 1 app(s) [run_1]`);
    expect(c.write?.map((w) => w.path)).toEqual([`${DIR}/dev.yaml`]);
    expect(c.remove ?? []).toEqual([]);
  });

  it("commitTenant refuses a registration whose cluster is marked for a DIFFERENT stage, and the error names both sides", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo(), marked({ s1: "dev" }));
    const attempt = () => reg.commitTenant({ stage: "prod", guid: GUID, registration: registration({ cluster: "s1" }), runId: "run_1" });
    await expect(attempt()).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(attempt()).rejects.toThrow(/names stage "prod".*marked "dev"/s);
  });

  it("readTenant reads back exactly what commitTenant wrote", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    const t = await reg.readTenant("dev", GUID);
    expect(t?.entry.cluster).toBe("s1");
    expect(t?.entry.subdomain).toBe("simetrix.dev");
    expect(t?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false }]);
    expect(t?.entry.seedUsers).toBe(false);
    expect(t?.entry.resetNonce).toBe("1");
    expect(t?.entry.suspended).toBe(false);
    expect(t?.entry.quiesced).toBe(false);
  });

  it("ROUND-TRIP (drop-trap): every registration field survives write -> re-read intact", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    const full = registration({
      cluster: "s1", subdomain: "simetrix.dev",
      members: testMembers([{ name: "erp", seedReference: true, seedDemo: false }]), identityProvider: "auth",
      apps: [{ name: "erp", seedReference: true, seedDemo: false }],
      seedUsers: true, quota: seedQuota("small"), resetNonce: "7", suspended: true, quiesced: true,
    });
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: full, runId: "run_1" });
    // A field the serializer silently dropped would fail this deep-equal — the whole body must survive.
    expect((await reg.readTenant("dev", GUID))?.entry).toEqual(full);
  });

  it("DROP-TRAP: updateTenantApps rewrites the registration WITHOUT dropping cluster/seedUsers/resetNonce/quiesced", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration({ seedUsers: true, quota: seedQuota("small"), resetNonce: "3", quiesced: true }), runId: "run_1" });
    await reg.updateTenantApps("dev", GUID, { op: "append", app: "web", member: testMembers(["web"])[3]!, runId: "run_2" });
    // The REWRITTEN bytes still carry every field (a field the writer omits is silently erased — and a
    // dropped cluster/pin would cascade onto a LIVE tenant's fan-out)...
    const rewritten = repo.commits[1]!.write?.[0]?.content ?? "";
    expect(rewritten).toContain('cluster: "s1"');
    expect(rewritten).toContain("seedUsers: true");
    expect(rewritten).toContain('resetNonce: "3"');
    expect(rewritten).toContain("quiesced: true");
    // ...and the fold agrees after the app change.
    const t = await reg.readTenant("dev", GUID);
    expect(t?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }]);
    expect(t?.entry.cluster).toBe("s1");
    expect(t?.entry.seedUsers).toBe(true);
    expect(t?.entry.resetNonce).toBe("3");
    expect(t?.entry.quiesced).toBe(true);
  });

  it("DROP-TRAP: setTenantSuspended preserves cluster/seedUsers/resetNonce/quiesced across the flip AND the flip back", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration({ seedUsers: true, quota: seedQuota("small"), resetNonce: "3", quiesced: true }), runId: "run_1" });
    await reg.setTenantSuspended("dev", GUID, true, "run_2");
    await reg.setTenantSuspended("dev", GUID, false, "run_3");
    const t = await reg.readTenant("dev", GUID);
    expect(t?.entry.suspended).toBe(false);
    expect(t?.entry.cluster).toBe("s1");
    expect(t?.entry.seedUsers).toBe(true);
    expect(t?.entry.resetNonce).toBe("3");
    expect(t?.entry.quiesced).toBe(true);
  });

  it("returns null for a tenant that was never committed", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    expect(await reg.readTenant("dev", GUID)).toBeNull();
  });

  it("updateTenantApps rewrites the ONE registration file, refuses duplicate + reserved names", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    await reg.updateTenantApps("dev", GUID, { op: "append", app: "web", member: testMembers(["web"])[3]!, runId: "run_2" });
    const t = await reg.readTenant("dev", GUID);
    expect(t?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }]);
    expect(repo.commits[1]!.write?.map((w) => w.path)).toEqual([`${DIR}/dev.yaml`]);
    expect(repo.commits[1]!.message).toBe(`tenant-add-app(${GUID}): +web [run_2]`);
    await expect(reg.updateTenantApps("dev", GUID, { op: "append", app: "erp", member: testMembers(["erp"])[3]!, runId: "r" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reg.updateTenantApps("dev", GUID, { op: "append", app: "auth", member: testMembers(["auth"])[3]!, runId: "r" })).rejects.toMatchObject({ code: "VALIDATION" }); // reserved
  });

  it("append carries both per-app seed tiers into apps[] (and folds them back), default false when omitted", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration({ apps: [], members: testMembers([]) }), runId: "run_1" });
    await reg.updateTenantApps("dev", GUID, { op: "append", app: "web", member: testMembers(["web"])[3]!, seedReference: true, seedDemo: true, runId: "run_2" }); // seedable later-added app
    await reg.updateTenantApps("dev", GUID, { op: "append", app: "crm", member: testMembers(["crm"])[3]!, runId: "run_3" }); // no tiers ⇒ both false
    const t = await reg.readTenant("dev", GUID);
    expect(t?.entry.apps).toEqual([{ name: "web", seedReference: true, seedDemo: true }, { name: "crm", seedReference: false, seedDemo: false }]);
  });

  it("legacy pointers fold unchanged: a raw {name} and a legacy {name, seed:true} both fold to canonical seed tiers", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    // Seed a LEGACY registration carrying the two on-disk shapes the old formats wrote: a raw {name}
    // (from before the seed tiers) and a {name, seed:true} (the legacy demo alias). The read side folds BOTH — seed → seedDemo.
    const legacy = tenantRegistrationWrite("dev", GUID, registration({ members: testMembers(["erp", "web"]), apps: [
      { name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false },
    ] }));
    const canonical = '[{"name":"erp","seedReference":false,"seedDemo":false},{"name":"web","seedReference":false,"seedDemo":false}]';
    const onDisk = '[{"name":"erp"},{"name":"web","seed":true}]';
    repo.seed(repo.booksBranch, legacy.path, legacy.content.replace(canonical, onDisk));
    const t = await reg.readTenant("dev", GUID);
    // erp: bare {name} ⇒ both tiers false; web: legacy seed:true ⇒ seedDemo:true (seedReference stays false).
    expect(t?.entry.apps).toEqual([
      { name: "erp", seedReference: false, seedDemo: false },
      { name: "web", seedReference: false, seedDemo: true },
    ]);
  });

  it("updateTenantApps drops an app and refuses dropping an absent one", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration({ apps: [{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }], members: testMembers(["erp", "web"]) }), runId: "run_1" });
    await reg.updateTenantApps("dev", GUID, { op: "drop", app: "erp", runId: "run_2" });
    expect((await reg.readTenant("dev", GUID))?.entry.apps).toEqual([{ name: "web", seedReference: false, seedDemo: false }]);
    expect(repo.commits[1]!.message).toBe(`tenant-remove-app(${GUID}): -erp [run_2]`);
    await expect(reg.updateTenantApps("dev", GUID, { op: "drop", app: "nope", runId: "r" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("updateTenantApps refuses when the tenant is not onboarded", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await expect(reg.updateTenantApps("dev", GUID, { op: "append", app: "web", member: testMembers(["web"])[3]!, runId: "r" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("setTenantSuspended flips the field in the registration in place (NOT a git-mv)", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    await reg.setTenantSuspended("dev", GUID, true, "run_2");
    const s = repo.commits[1]!;
    expect(s.message).toBe(`tenant-suspend(${GUID}) [run_2]`);
    expect(s.write?.map((w) => w.path)).toEqual([`${DIR}/dev.yaml`]); // the one file
    expect(s.remove ?? []).toEqual([]); // field flip, not a move
    expect(s.write?.[0]?.content).toContain("suspended: true");
    expect((await reg.readTenant("dev", GUID))?.entry.suspended).toBe(true);
    await reg.setTenantSuspended("dev", GUID, false, "run_3");
    expect((await reg.readTenant("dev", GUID))?.entry.suspended).toBe(false);
    expect(repo.commits[2]!.message).toBe(`tenant-resume(${GUID}) [run_3]`);
  });

  it("subdomainGuids scans the GitOps pointers and returns every guid whose registration carries the subdomain", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    const OTHER = "e2e8ymj86dk8";
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" }); // simetrix.dev
    await reg.commitTenant({ stage: "dev", guid: OTHER, registration: registration({ subdomain: "simetrix.dev" }), runId: "run_2" });
    await reg.commitTenant({ stage: "dev", guid: "zzzzzzzzzzzz", registration: registration({ subdomain: "other.dev" }), runId: "run_3" });
    expect((await reg.subdomainGuids("dev", "simetrix.dev")).sort()).toEqual([OTHER, GUID].sort());
    expect(await reg.subdomainGuids("dev", "other.dev")).toEqual(["zzzzzzzzzzzz"]);
    expect(await reg.subdomainGuids("dev", "absent.dev")).toEqual([]);
    expect(await reg.subdomainGuids("prod", "simetrix.dev")).toEqual([]); // stage-scoped
  });

  it("listTenantGuids is the SAME scan without the subdomain filter — every deployed guid at the stage", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    const OTHER = "e2e8ymj86dk8";
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" }); // simetrix.dev
    await reg.commitTenant({ stage: "dev", guid: OTHER, registration: registration({ subdomain: "other.dev" }), runId: "run_2" });
    // The discovery source for an ORPHAN: a guid with a live registration and no
    // tenants row is invisible to inventory but named here, which is what makes a tenant-purge possible.
    expect((await reg.listTenantGuids("dev")).sort()).toEqual([OTHER, GUID].sort());
    expect(await reg.listTenantGuids("prod")).toEqual([]); // stage-scoped, like subdomainGuids
    // Both scans skip a BROKEN registration rather than throwing — one drifted tenant must never wedge the
    // discovery of every other one.
    repo.seed(repo.booksBranch, "registrations/zzzzzzzzzzzz/dev.yaml", "subdomain: \"ghost.example\"\n"); // no cluster ⇒ fails schema
    expect((await reg.listTenantGuids("dev")).sort()).toEqual([OTHER, GUID].sort());
    expect((await reg.subdomainGuids("dev", "simetrix.dev"))).toEqual([GUID]);
  });

  it("listTenantPointers is the same scan projecting subdomain + cluster — what NAMES an orphan and aims its purge", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    const OTHER = "e2e8ymj86dk8";
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" }); // GUID / simetrix.dev on s1
    await reg.commitTenant({ stage: "dev", guid: OTHER, registration: registration({ subdomain: "other.dev", cluster: "s2" }), runId: "run_2" });
    // The orphan scan needs all three: the guid the purge is keyed on, the subdomain a human recognises,
    // and the ArgoCD-registered slave name the target cluster row is resolved from.
    const dev = await reg.listTenantPointers("dev");
    expect(dev.pointers.map((p) => ({ guid: p.guid, subdomain: p.subdomain, cluster: p.cluster })).sort((a, b) => a.guid.localeCompare(b.guid))).toEqual(
      [
        { guid: GUID, subdomain: "simetrix.dev", cluster: "s1" },
        { guid: OTHER, subdomain: "other.dev", cluster: "s2" },
      ].sort((a, b) => a.guid.localeCompare(b.guid)),
    );
    expect(dev.skipped).toEqual([]); // both registrations read cleanly — nothing was skipped
    expect(await reg.listTenantPointers("prod")).toEqual({ pointers: [], skipped: [] }); // stage-scoped, like both sibling scans
  });

  it("removeTenant removes the ONE registration file (offboard); a second offboard is refused", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    await reg.removeTenant("dev", GUID, "run_2");
    const off = repo.commits[1]!;
    expect(off.message).toBe(`tenant-offboard(${GUID}): dev [run_2]`);
    expect(off.remove).toEqual([`${DIR}/dev.yaml`]);
    expect(await reg.readTenant("dev", GUID)).toBeNull();
    await expect(reg.removeTenant("dev", GUID, "run_3")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("removeTenant removes a tenant whose registration is CORRUPT — the guard asks presence, not a full fold", async () => {
    // The path is built from stage+guid and needs no body at all, so the only question the refusal may
    // ask is "does a registration file stand here". Parsing it would refuse to remove precisely the
    // broken tenant an offboard/purge is aimed at — the guard would protect the leftover, not the tenant.
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    repo.seed(repo.booksBranch, `${DIR}/dev.yaml`, 'cluster: "s1"\nsubdomain: 7\n'); // subdomain must be a string
    await expect(reg.readTenant("dev", GUID)).rejects.toThrow(/dev\.yaml failed its schema/); // the strict fold still refuses
    await reg.removeTenant("dev", GUID, "run_2");
    expect(repo.commits[0]!.remove).toEqual([`${DIR}/dev.yaml`]);
    expect(await reg.readTenant("dev", GUID)).toBeNull();
  });
});

// The scan is the ONLY thing that can NAME a tenant the inventory does not know,
// so what it cannot read has to come back OUT of it: a registration dropped in silence turns the orphan
// scan's empty answer into "everything is accounted for" — unfalsifiable from the UI, and permanent,
// because the purge dialog only ever offers a guid something handed the operator.
describe("the pointer scan reports what it could NOT read", () => {
  const OTHER = "e2e8ymj86dk8";

  /** A registrations whose fake catalog carries GUID as a clean registration plus one seeded raw file. */
  async function withSeeded(path: string, content: string): Promise<TenantRegistrations> {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
    await reg.commitTenant({ stage: "dev", guid: GUID, registration: registration(), runId: "run_1" });
    repo.seed(repo.booksBranch, path, content);
    return reg;
  }

  it("carries a corrupt registration out as skipped {guid, stage, reason} — the guid is the DIRECTORY", async () => {
    const reg = await withSeeded(`registrations/${OTHER}/dev.yaml`, 'subdomain: "ghost.example"\n'); // no cluster ⇒ fails schema
    const { pointers, skipped } = await reg.listTenantPointers("dev");
    expect(pointers.map((p) => p.guid)).toEqual([GUID]); // the readable tenant is unaffected — one broken registration wedges nothing
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ guid: OTHER, stage: "dev" });
    expect(skipped[0]!.reason).toContain(`registrations/${OTHER}/dev.yaml failed its schema`);
  });

  it("carries a registration that is not valid YAML out the same way", async () => {
    const reg = await withSeeded(`registrations/${OTHER}/dev.yaml`, "cluster: \"unterminated\n  - [\n");
    const { skipped } = await reg.listTenantPointers("dev");
    expect(skipped.map((s) => s.guid)).toEqual([OTHER]);
    expect(skipped[0]!.reason).toContain("is not valid YAML");
  });

  it("scanTenant answers the three states apart: read, unreadable (with the reason), absent", async () => {
    // The per-guid twin of the scan — the read every REMOVAL resolves through. "unreadable" is NOT
    // "absent": a registration file stands at that path and must still be git-rm'd.
    const reg = await withSeeded(`registrations/${OTHER}/dev.yaml`, 'subdomain: "ghost.example"\n');
    expect(await reg.scanTenant("dev", GUID)).toEqual({
      status: "read",
      entry: {
        guid: GUID, subdomain: "simetrix.dev", stage: "dev", cluster: "s1",
        members: ["auth", "jobs", "report", "erp"],
        apps: [{ name: "erp", seedReference: false, seedDemo: false }],
      },
    });
    expect(await reg.scanTenant("dev", OTHER)).toMatchObject({ status: "unreadable" });
    expect(await reg.scanTenant("prod", GUID)).toEqual({ status: "absent" });
  });
});
