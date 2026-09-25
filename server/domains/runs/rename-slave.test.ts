import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { apps, clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import { makeRenameSlaveDef, type RenameSlaveParams, type RenameSlavePorts } from "./defs/rename-slave.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { SLAVE_ID, MASTER_ID, PARAMS, makeHarness, disposeHarnesses, hostedStepCtx, seedMasterCluster, type Harness } from "./deploy-slave.fixture.ts";

// MOVING A LIVE SLAVE ONTO ANOTHER FQDN — the run kind's own steps, driven one by one. The machine
// layer between them is redeploy's, proven where redeploy is; what is held here is what the rename
// adds: nothing moves before it is attested, the name stays, every move has its way back, and the
// run ends on the units.

const TO = "s1.elsewhere.example.org";
const P: RenameSlaveParams = { serverId: SLAVE_ID, fromFqdn: PARAMS.domain, newFqdn: TO };
const APPSET_BY_NAME = "        values:\n          cluster: '{{ .global.clusterName }}'\n";
const APPSET_BY_DOMAIN = "        values:\n          cluster: '{{ index (splitList \".\" .global.domain) 0 }}'\n";
const SYNCED: ArgoAppStatus = { syncRevision: "a".repeat(40), targetRevision: null, sync: "Synced", health: "Healthy" };

function seedLiveSlave(h: Harness): void {
  seedMasterCluster(h);
  h.db.db.insert(clusters).values({
    id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, name: "s1", status: "active", slaveId: 1,
    planeState: "ready", planeJson: { v: 0, branch: PARAMS.domain },
  }).run();
  h.db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
}

function portsOf(h: Harness, over: Partial<RenameSlavePorts> = {}): RenameSlavePorts {
  return { ...h.runPorts, ...over } as RenameSlavePorts;
}

function stepOf(ports: RenameSlavePorts, name: string): Step {
  const step = makeRenameSlaveDef(ports).steps(P).find((s) => s.name === name);
  if (!step) throw new Error(`no step ${name}`);
  return step;
}

function ctxOf(h: Harness, sink: { logs: string[]; cleanups: Cleanup[] }, checkpoint?: unknown): StepCtx {
  return hostedStepCtx(h, {
    log: (_s, l) => sink.logs.push(l),
    registerCleanup: (c) => sink.cleanups.push(c),
    readCheckpoint: <T,>() => checkpoint as T | undefined,
  });
}

describe("cluster-rename", () => {
  afterEach(disposeHarnesses);

  it("attests, moves the row, writes the wildcard and attests the MACHINE before anything in git or DNS moves, and ends on the units", async () => {
    const h = await makeHarness();
    const names = makeRenameSlaveDef(portsOf(h)).steps(P).map((s) => s.name);
    expect(names.slice(0, 6)).toEqual(["attest-target", "repoint-identity", "ensure-wildcard", "attest-machine", "move-map", "repoint-unit-records"]);
    expect(names.slice(-2)).toEqual(["remove-old-records", "verify-applications"]);
    expect(new Set(names).size).toBe(names.length);
    expect(makeRenameSlaveDef(portsOf(h)).cleanups!(P).map((c) => c.name)).toEqual(["restore-identity", "move-map-back", "repoint-unit-records-back"]);
  });

  it("plans only from the FQDN the slave stands at, onto one no cluster holds, and never a master", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const plan = (p: RenameSlaveParams) => makeRenameSlaveDef(portsOf(h)).plan(p, { db: h.db.db } as never);
    await expect(plan({ ...P, fromFqdn: "s1.old.example.com" })).rejects.toThrow(/stands at s1\.example\.com, not at s1\.old\.example\.com/);
    await expect(plan({ ...P, newFqdn: PARAMS.domain })).rejects.toThrow(/already stands at s1\.example\.com/);
    await expect(plan({ ...P, newFqdn: "m1.example.com" })).rejects.toThrow(/already the FQDN of cluster cls_master/);
    await expect(plan({ ...P, serverId: MASTER_ID, fromFqdn: "m1.example.com" })).rejects.toThrow(/carries the master part/);
    const planned = await plan(P);
    expect(planned.summary).toContain("Its name stays s1");
    expect(planned.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
  });

  it("refuses under a slaves ApplicationSet that works a slave's name out of its domain, and where a map stands at the new FQDN", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    h.platformRepo.seed(h.platformRepo.booksBranch, "clusters/argocd/files/slaves-appset.yaml", APPSET_BY_DOMAIN);
    await expect(stepOf(portsOf(h), "attest-target").run(ctxOf(h, sink))).rejects.toThrow(/does not name a slave by the clusterName its map records.*prune the standing one/s);
    h.platformRepo.seed(h.platformRepo.booksBranch, "clusters/argocd/files/slaves-appset.yaml", APPSET_BY_NAME);
    h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(TO), "stage: prod\n");
    await expect(stepOf(portsOf(h), "attest-target").run(ctxOf(h, sink))).rejects.toThrow(/already stands on/);
  });

  it("points the row and the server's host at the new FQDN, and its compensation points both back", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    await stepOf(portsOf(h), "repoint-identity").run(ctxOf(h, sink));
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_s1")).get()).toMatchObject({ domain: TO, name: "s1" });
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.host).toBe(TO);
    expect(sink.cleanups.map((c) => c.name)).toEqual(["restore-identity"]);
    await sink.cleanups[0]!.run(ctxOf(h, sink));
    expect(h.db.db.select().from(clusters).where(eq(clusters.id, "cls_s1")).get()?.domain).toBe(PARAMS.domain);
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.host).toBe(PARAMS.domain);
  });

  it("leaves a host the row states some other way as it was stated", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    h.db.db.update(servers).set({ host: "203.0.113.9" }).where(eq(servers.id, SLAVE_ID)).run();
    await stepOf(portsOf(h), "repoint-identity").run(ctxOf(h, { logs: [], cleanups: [] }));
    expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.host).toBe("203.0.113.9");
  });

  it("moves the map in one commit with its name, and its compensation moves it back", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    const before = h.platformRepo.commits.length;
    await stepOf(portsOf(h), "move-map").run(ctxOf(h, sink));
    expect(h.platformRepo.commits.length).toBe(before + 1);
    expect(h.platformRepo.commits.at(-1)).toMatchObject({ remove: [clusterMapPath(PARAMS.domain)] });
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain))).toBeNull();
    const moved = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(TO)) ?? "";
    expect(moved).toContain(`domain: ${TO}`);
    expect(moved).toContain("clusterName: s1");
    await sink.cleanups[0]!.run(ctxOf(h, sink));
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(TO))).toBeNull();
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain))).toContain("clusterName: s1");
  });

  it("repoints the unit records through the port, and back the other way on an abort", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    const asked: { from: string; to: string }[] = [];
    const ports = portsOf(h, { unitRecords: async (_ctx, input) => { asked.push({ from: input.from, to: input.to }); return ["post.example.com"]; } });
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    await stepOf(ports, "repoint-unit-records").run(ctxOf(h, sink));
    await sink.cleanups[0]!.run(ctxOf(h, sink));
    expect(asked).toEqual([{ from: PARAMS.domain, to: TO }, { from: TO, to: PARAMS.domain }]);
  });

  it("writes the new wildcard and takes the old FQDN's records away, and leaves both where the zone is nobody's here", async () => {
    const h = await makeHarness();
    const dns = new FakeDnsProvider();
    dns.seed(`*.${PARAMS.domain}`, "CNAME", PARAMS.domain);
    dns.seed(PARAMS.domain, "A", "203.0.113.11");
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    await stepOf(portsOf(h, { dns }), "ensure-wildcard").run(ctxOf(h, sink));
    expect(dns.record(`*.${TO}`, "CNAME")).toBe(TO);
    await stepOf(portsOf(h, { dns }), "remove-old-records").run(ctxOf(h, sink));
    expect(dns.record(`*.${PARAMS.domain}`, "CNAME")).toBeUndefined();
    expect(dns.record(PARAMS.domain, "A")).toBeUndefined();

    const elsewhere = new FakeDnsProvider();
    elsewhere.unmanaged = ["elsewhere.example.org", "example.com"];
    await stepOf(portsOf(h, { dns: elsewhere }), "ensure-wildcard").run(ctxOf(h, sink));
    await stepOf(portsOf(h, { dns: elsewhere }), "remove-old-records").run(ctxOf(h, sink));
    expect(sink.logs.join("\n")).toMatch(/in no zone this installation manages, so it is not written here/);
    expect(sink.logs.join("\n")).toMatch(/not this installation's to remove — left as they stand/);
  });

  it("ends only where every consumer's Application on the slave stands and is Synced, naming the one that does not", async () => {
    const h = await makeHarness();
    seedLiveSlave(h);
    h.db.db.insert(apps).values({ id: "app_post", clusterId: "cls_s1", name: "post", stage: "prod", host: "post", provenance: "manager", status: "active" }).run();
    const sink = { logs: [] as string[], cleanups: [] as Cleanup[] };
    h.argo.setStatuses(new Map([["post-prod", SYNCED]]));
    await stepOf(portsOf(h), "verify-applications").run(ctxOf(h, sink));
    expect(sink.logs.join("\n")).toContain("every one of the 1 consumer Application(s) of s1 stands and is Synced");
    h.argo.setStatuses(new Map());
    await expect(stepOf(portsOf(h), "verify-applications").run(ctxOf(h, sink))).rejects.toThrow(/no Application stands for post-prod/);
  });
});
