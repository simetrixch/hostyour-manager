import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { recordBackupStarted, recordBackupFinished } from "../../db/unit-backups.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeClusterKubeResolver, FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import type { Cleanup, PlanStreamCtx, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { testMembers, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { makeTenantLineMoveDef, type TenantLineMoveParams, type TenantLineMovePorts } from "./tenant-line-move.run.ts";
import { readTenantLineMoves } from "./tenant-line-move.ts";
import type { TenantRelocationPorts } from "./relocation-world-tenant.ts";

// tenant-line-move over a tenant on line 0.3 whose bundle repository has released 0.4 and whose
// platform part (engine and app) has released 0.4 at prod: what it plans, the one commit it writes,
// what it waits for, and when its abort is refused.

const GUID = "zsjs023ctne0";
const DEPLOY_URL = "https://github.com/acme/acme-deploy.git";
const REPO = "https://github.com/acme-org/example-apps-acme.git";
const B03 = "0.3.002-stable-20260927000000";
const B04 = "0.4.000-stable-20261010120000";
const P03 = "0.3.009-stable-20261001000000-1111111";
const P04 = "0.4.001-stable-20261010000000-3333333";
const ENGINE = (line: string): string => `apps:\n  - name: erp\n    title: ERP\nengine:\n  build: example-engine\n  line: "${line}"\n`;
const MEMBERS = testMembers(["erp"]);
const EXPECTED = MEMBERS.map((m) => memberApplication(GUID, m.name, "prod"));
const ON_03 = { appsImageTag: `${B03}-aaaaaaa`, approvedTags: { erp: { "example-engine": P03, "example-app": P03 } } };
const ON_04 = { appsImageTag: `${B04}-bbbbbbb`, approvedTags: { erp: { "example-engine": P04, "example-app": P04 } } };

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** Every member Application Synced + Healthy, rendering `pairing`: its versions and its bundle. */
function rendering(pairing: { appsImageTag: string; approvedTags: Record<string, Record<string, string>> }): Map<string, ArgoAppStatus> {
  return new Map(EXPECTED.map((name) => [name, {
    syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", namespaceLabels: {},
    syncSources: [{ repoURL: DEPLOY_URL, revision: "a".repeat(40), path: "charts/example-engine", valueFiles: [], valuesObject: { tenant: { guid: GUID, approvedTags: pairing.approvedTags, appsImageTag: pairing.appsImageTag } } }],
  } as ArgoAppStatus]));
}

class StatusArgo extends FakeMasterArgoReader {
  statuses: Map<string, ArgoAppStatus> = rendering(ON_03);
  override async watchApplicationSet(): Promise<ArgoAppStatusMap> {
    return this.statuses;
  }
}

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function world(pairing = ON_03): { ports: TenantLineMovePorts; registrations: TenantRegistrations; argo: StatusArgo; books: FakePlatformRepo } {
  const books = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "acme", members: MEMBERS, identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), appsRepo: REPO, appsImage: "example-apps-acme", ...pairing });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  books.seed(books.booksBranch, w.path, w.content);
  books.seed(books.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile({ "example-engine": P03, "example-app": P03 }));
  books.seed(books.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile({ "example-engine": P04, "example-app": P04 }));
  const reader = new FakeRepoReader();
  reader.scriptFor(REPO, { tags: [{ name: B03, commit: "a".repeat(40) }, { name: B04, commit: "b".repeat(40) }] });
  reader.scriptFor(`${REPO}@${B03}`, { files: { "apps.yaml": ENGINE("0.3") } });
  reader.scriptFor(`${REPO}@${B04}`, { files: { "apps.yaml": ENGINE("0.4") } });
  const registrations = new TenantRegistrations(books);
  const argo = new StatusArgo();
  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-10-01T00:00:00Z", generation: 3 } }),
    argoReader: argo, projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
  });
  const ports = {
    registrations, repo: reader, registryProbe: new FakeRegistryProbe(), resolver, deployRepoUrl: DEPLOY_URL, argoWatchTimeoutMs: 1000,
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "example-platform", build: "example-app" }],
    channelStages: async () => TEST_CHANNEL_STAGES,
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    registry:\n      host: zot.m1.example\n" }],
    // No storage box is wired: a backup refuses, as it does on a manager without one.
    relocation: { registrations, resolver, deployRepoUrl: DEPLOY_URL, argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com" } as unknown as TenantRelocationPorts,
  } as unknown as TenantLineMovePorts;
  return { ports, registrations, argo, books };
}

const planCtx = (): PlanStreamCtx => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });
function stepCtx(p: TenantLineMoveParams, cleanups: Cleanup[] = []): StepCtx {
  return {
    runId: "run_move", stepName: "step", db: db.db, creds: {} as unknown as CredentialStore, params: p as unknown as StepCtx["params"],
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: (c) => cleanups.push(c),
  };
}

async function plan(ports: TenantLineMovePorts, line = "0.4") {
  return makeTenantLineMoveDef(ports).planStream!({ tenantId: "tnt_1", line }, planCtx());
}
async function planned(ports: TenantLineMovePorts): Promise<TenantLineMoveParams> {
  const result = await plan(ports);
  if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
  return result.params as TenantLineMoveParams;
}
const step = (ports: TenantLineMovePorts, p: TenantLineMoveParams, name: string) => makeTenantLineMoveDef(ports).steps(p).find((s) => s.name === name)!;
const pairingOf = async (r: TenantRegistrations) => {
  const t = await r.readTenant("prod", GUID);
  return { appsImageTag: t!.entry.appsImageTag, approvedTags: t!.entry.approvedTags };
};

describe("tenant-line-move plans", () => {
  it("the move with both pairings, a backup before the one commit, and the warnings that say what the way back is", async () => {
    const { ports } = world();
    const result = await plan(ports);
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    const p = result.params as TenantLineMoveParams;
    expect([p.fromLine, p.line, p.standing]).toEqual(["0.3", "0.4", false]);
    expect(p.previous).toEqual(ON_03);
    expect(p.target).toEqual(ON_04);
    expect(result.plan.steps.map((s) => s.name)).toEqual(["attest-target", "backup", "write-pairing", "watch-pairing"]);
    expect(result.plan.warnings.join(" ")).toMatch(/taken online, as fits the seeded showcases/);
    expect(result.plan.warnings.join(" ")).toMatch(/the Restore of this run's line-move generation is, and the abort is refused from then on/);
    expect(result.plan.warnings.join(" ")).toMatch(/7 newer verified generations of the tenant stand, whatever took them/);
  });

  it("PLANTED DEFECT: rejects what the pairing reader refuses, naming it", async () => {
    const result = await plan(world().ports, "0.2");
    expect(result).toMatchObject({ outcome: "rejected", summary: "tenant acme cannot move to line 0.2: line 0.2 is not newer than line 0.3, which tenant acme runs" });
  });

  it("a watch alone for a tenant that already carries the target pairing: no backup, no commit, nothing to undo", async () => {
    const { ports } = world(ON_04);
    const p = await planned(ports);
    expect(p.standing).toBe(true);
    expect(makeTenantLineMoveDef(ports).steps(p).map((s) => s.name)).toEqual(["attest-target", "watch-pairing"]);
    expect(makeTenantLineMoveDef(ports).cleanups!(p)).toEqual([]);
  });
});

describe("tenant-line-move writes", () => {
  it("both halves in ONE registration commit, and the tenants row follows", async () => {
    const { ports, registrations, books } = world();
    const p = await planned(ports);
    const before = books.commits.length;
    const cleanups: Cleanup[] = [];
    await step(ports, p, "write-pairing").run(stepCtx(p, cleanups));
    expect(books.commits.length - before).toBe(1);
    expect(await pairingOf(registrations)).toEqual(ON_04);
    expect(db.db.select({ approvedTags: tenants.approvedTags }).from(tenants).get()?.approvedTags).toEqual(ON_04.approvedTags);
    expect(cleanups.map((c) => c.name)).toEqual(["restore-pairing"]);
  });

  it("PLANTED DEFECT: refuses where the registration carries neither pairing, as another run moved the tenant since", async () => {
    const { ports, registrations } = world();
    const p = await planned(ports);
    await registrations.setApprovedTags("prod", GUID, { erp: { "example-engine": P04, "example-app": P03 } }, "run_other");
    await expect(step(ports, p, "write-pairing").run(stepCtx(p))).rejects.toThrow(/changed since this run was planned/);
  });

  it("PLANTED DEFECT: a backup that cannot be taken stops the run before anything is written", async () => {
    const { ports, registrations } = world();
    const p = await planned(ports);
    await expect(step(ports, p, "backup").run(stepCtx(p))).rejects.toThrow(/the line-move backup requires the Hetzner Storage Box/);
    expect(await pairingOf(registrations)).toEqual(ON_03);
  });

  it("its undo writes the previous pairing back while the registration carries this run's", async () => {
    const { ports, registrations } = world();
    const p = await planned(ports);
    const cleanups: Cleanup[] = [];
    await step(ports, p, "write-pairing").run(stepCtx(p, cleanups));
    await cleanups[0]!.run(stepCtx(p));
    expect(await pairingOf(registrations)).toEqual(ON_03);
  });

  it("PLANTED INNOCENT: its undo leaves a pairing a Restore or another run wrote since", async () => {
    const { ports, registrations } = world();
    const p = await planned(ports);
    const cleanups: Cleanup[] = [];
    await step(ports, p, "write-pairing").run(stepCtx(p, cleanups));
    const other = { appsImageTag: ON_04.appsImageTag, approvedTags: { erp: { "example-engine": P04, "example-app": P04, "example-extra": P04 } } };
    await registrations.setLinePairing("prod", GUID, other, "run_other");
    await cleanups[0]!.run(stepCtx(p));
    expect(await pairingOf(registrations)).toEqual(other);
  });
});

describe("tenant-line-move waits", () => {
  it("until every member renders the new versions and the new bundle", async () => {
    const { ports, argo } = world();
    const p = await planned(ports);
    await step(ports, p, "write-pairing").run(stepCtx(p));
    argo.statuses = rendering(ON_04);
    await step(ports, p, "watch-pairing").run(stepCtx(p));
  });

  it("PLANTED DEFECT: not where a member renders the new versions on the old bundle", async () => {
    const { ports, argo } = world();
    const p = await planned(ports);
    await step(ports, p, "write-pairing").run(stepCtx(p));
    argo.statuses = rendering({ appsImageTag: ON_03.appsImageTag, approvedTags: ON_04.approvedTags });
    await expect(step(ports, p, "watch-pairing").run(stepCtx(p))).rejects.toThrow(/has not rendered line 0.4 yet/);
  });

  it("PLANTED DEFECT: refuses to settle green after a Restore wrote the old pairing back, and names the abort", async () => {
    const { ports, registrations, argo } = world();
    const p = await planned(ports);
    await step(ports, p, "write-pairing").run(stepCtx(p));
    await registrations.setLinePairing("prod", GUID, ON_03, "run_restore");
    argo.statuses = rendering(ON_03); // every member healthy, on the old line
    await expect(step(ports, p, "watch-pairing").run(stepCtx(p))).rejects.toThrow(/no longer carries the line-0.4 pairing this run wrote .* abort this run to close it/);
  });
});

describe("tenant-line-move's abort", () => {
  function takeGeneration(generation: string): void {
    recordBackupStarted(db.db, { kind: "tenant", unit: GUID, stage: "prod", generation, folder: `inst/prod/tenants/${GUID}/${generation}`, trigger: "line-move", runId: "run_move" });
    recordBackupFinished(db.db, { kind: "tenant", unit: GUID, stage: "prod", generation }, { state: "ok" });
  }

  it("passes while no member renders a part of the new pairing: writing the old one back is then complete", async () => {
    const { ports } = world();
    const p = await planned(ports);
    await step(ports, p, "write-pairing").run(stepCtx(p));
    await expect(makeTenantLineMoveDef(ports).assertAbortable!(p, { db: db.db })).resolves.toBeUndefined();
  });

  it("PLANTED DEFECT: is refused once a member renders the new line, naming the generation to restore", async () => {
    const { ports, argo } = world();
    const p = await planned(ports);
    takeGeneration("20261010T120000Z");
    await step(ports, p, "write-pairing").run(stepCtx(p));
    argo.statuses = rendering(ON_04);
    await expect(makeTenantLineMoveDef(ports).assertAbortable!(p, { db: db.db })).rejects.toThrow(/already renders line 0.4.*The way back is the Restore of generation 20261010T120000Z/);
  });

  it("PLANTED INNOCENT: passes after a Restore wrote the old pairing back, so the abort closes the run", async () => {
    const { ports, registrations, argo } = world();
    const p = await planned(ports);
    await step(ports, p, "write-pairing").run(stepCtx(p));
    argo.statuses = rendering(ON_04);
    await registrations.setLinePairing("prod", GUID, ON_03, "run_restore");
    await expect(makeTenantLineMoveDef(ports).assertAbortable!(p, { db: db.db })).resolves.toBeUndefined();
  });
});

describe("the Versions dialog's offer", () => {
  it("is the move the plan would write: the newer line, both bundles and the part's tag", async () => {
    expect(await readTenantLineMoves(world().ports, db.db, "tnt_1")).toEqual({
      line: "0.3",
      offer: { line: "0.4", fromBundle: ON_03.appsImageTag, toBundle: ON_04.appsImageTag, part: "example-platform", partTag: P04, builds: ["example-engine", "example-app"], refusals: [] },
    });
  });

  it("PLANTED INNOCENT: offers nothing to a tenant already on the newest line, and names no line for a tenant without a bundle", async () => {
    expect(await readTenantLineMoves(world(ON_04).ports, db.db, "tnt_1")).toEqual({ line: "0.4", offer: null });
    const { ports, registrations } = world();
    await registrations.clearTenantAppsRepo("prod", GUID, "run_x");
    expect(await readTenantLineMoves(ports, db.db, "tnt_1")).toEqual({ line: null, offer: null });
  });
});
