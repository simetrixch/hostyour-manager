import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { ATTEST_TARGET_STEP } from "../../executor/guards.ts";
import { deriveServerLocks } from "../../executor/locks.ts";
import type { AnyRunDefinition, RunDefinition } from "../../executor/types.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { makeTailnetDisconnectDef, makeTailnetReadDef, makeTailnetReconnectDef, makeTailnetRejoinDef, type TailnetParams } from "./defs/tailnet.ts";
import type { TailnetKind } from "./defs/tailnet.kit.ts";

// The PLAN of the four tailnet run kinds — everything the operator approves before a machine is asked
// anything: which address the run is aimed at, what it locks, whose hosts it names, and what it
// demands at approve. The acts themselves are ansiwise programs now, and driving them takes a real
// `ansiwise-rest serve`; the executed proofs — the program runs, the address every session actually
// dialled, the membership write-back — live in redeploy.ansiwise.test.ts, the ONE file that starts
// machine runs (the engine's run root is per-drive, so two serve fixtures in parallel would share
// records and collide).
//
// The address property the whole family rests on is stated HERE, on the plan: a run kind whose purpose
// is to repair the private network may not travel over it, and may not travel over the LAN address
// either — so the host target carries `transport: "public"`, which the executor resolves to
// servers.host (executor/transport.ts) and the frozen plan_json records.

const SLAVE_ID = "srv_s1";
const MASTER_ID = "srv_m1";
const PUBLIC_HOST = "203.0.113.7";
const LAN_HOST = "10.1.1.11";
/** The address the host holds on the private network. It lives in the tailnet READING and in no
 *  column any target builder reads — so no plan may ever aim a session at it. */
const TAILNET_ADDRESS = "100.71.4.9";

// Keyed on TailnetKind, not on string: a run kind renamed in shared/enums.ts must break THIS file
// rather than leave the table testing keys the enum no longer has.
const DEFS: Record<TailnetKind, RunDefinition<TailnetParams>> = {
  "cluster-tailnet-disconnect": makeTailnetDisconnectDef({}),
  "cluster-tailnet-reconnect": makeTailnetReconnectDef({}),
  "cluster-tailnet-rejoin": makeTailnetRejoinDef({}),
  "cluster-tailnet-read": makeTailnetReadDef({}),
};

/** The one manager-side step each run kind has between the shared attest and the shared read: the
 *  program step for the two single-host run kinds (named run-<program>, after the CATALOGUE program
 *  the kit maps the kind to), and the mint-carry-rejoin choreography for the third. The READ has
 *  none, and that absence is the run kind: attest the box, read it, stop. */
const MIDDLE_STEP: Record<TailnetKind, string | null> = {
  "cluster-tailnet-disconnect": "run-tailnet-disconnect",
  "cluster-tailnet-reconnect": "run-tailnet-reconnect",
  "cluster-tailnet-rejoin": "rejoin",
  "cluster-tailnet-read": null,
};

describe("the tailnet run kinds — the plan they are approved on", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A live slave that carries BOTH addresses and a tailnet reading, plus the master a rejoin
   *  needs. Both addresses are present on purpose: a plan that named the LAN one would look
   *  identical on a row that has only a public address. */
  function setup(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-tailnet-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    db.db.insert(servers).values({
      id: SLAVE_ID, name: "s1", host: PUBLIC_HOST, lanHost: LAN_HOST, sshPort: 22, sshUser: "hostyour1",
      role: "slave", status: "healthy", tailnetState: "joined",
      tailnetJson: {
        v: 0, observedAt: 1, runId: "run_old", clientVersion: "1.80.2", backendState: "Running",
        address: TAILNET_ADDRESS, coordinator: "https://tailnet.example.com",
      },
    }).run();
    db.db.insert(servers).values({
      id: MASTER_ID, name: "m1", host: "198.51.100.4", lanHost: "10.1.1.1", sshPort: 22, sshUser: "hostyour",
      role: "master", status: "healthy",
    }).run();
    db.db.insert(clusters).values({
      id: "cls_1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1,
    }).run();
    return db;
  }

  for (const [kind, def] of Object.entries(DEFS) as [TailnetKind, RunDefinition<TailnetParams>][]) {
    it(`${kind} states the public address on its own plan target, so the frozen plan records it`, async () => {
      const db = setup();
      const plan = await def.plan({ serverId: SLAVE_ID }, { db: db.db });
      const host = plan.targets?.find((t) => t.serverId === SLAVE_ID);
      expect(host?.transport).toBe("public");
      expect(plan.summary).toContain(PUBLIC_HOST);
      expect(plan.summary).not.toContain(LAN_HOST);
      expect(plan.summary).not.toContain(TAILNET_ADDRESS);
    });

    it(`${kind} owns the host it repairs, so it takes the same server lock every host run kind takes`, async () => {
      const db = setup();
      const plan = await def.plan({ serverId: SLAVE_ID }, { db: db.db });
      // Without this a repair could run its logout on a host a deploy-slave in flight was joining.
      // A run that has settled holds no lock at all (the executor releases them on every terminal
      // path), so the broken deploy these run kinds exist for still cannot block them.
      expect(deriveServerLocks(plan.targets ?? [])).toEqual([{ resource: "server", key: SLAVE_ID }]);
      // The master is driven, not owned — only the host being repaired is claimed.
      expect(plan.targets?.filter((t) => t.ownsHost).map((t) => t.serverId)).toEqual([SLAVE_ID]);
      expect(plan.locks ?? []).toEqual([]);
    });

    it(`${kind} runs ${ATTEST_TARGET_STEP}, then ${MIDDLE_STEP[kind] ?? "nothing of its own"}, then reads the membership back`, async () => {
      const db = setup();
      const middle = MIDDLE_STEP[kind];
      const plan = await def.plan({ serverId: SLAVE_ID }, { db: db.db });
      expect(plan.steps.map((s) => s.name)).toEqual([ATTEST_TARGET_STEP, ...(middle === null ? [] : [middle]), "read-membership"]);
      // mutating ⇒ the executor refuses to let an operator skip that first step.
      expect((def as AnyRunDefinition).mutating).toBe(true);
    });

    it(`${kind} demands the elevation password at approve — the client's socket and the programs both need root`, async () => {
      const db = setup();
      const plan = await def.plan({ serverId: SLAVE_ID }, { db: db.db });
      expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    });
  }

  it("only a rejoin declares the master at all, and on its usual address — the other two touch one host", async () => {
    const db = setup();
    const rejoin = await DEFS["cluster-tailnet-rejoin"].plan({ serverId: SLAVE_ID }, { db: db.db });
    expect(rejoin.targets?.find((t) => t.serverId === MASTER_ID)?.transport).toBeUndefined();
    for (const kind of ["cluster-tailnet-disconnect", "cluster-tailnet-reconnect", "cluster-tailnet-read"] as const) {
      const plan = await DEFS[kind].plan({ serverId: SLAVE_ID }, { db: db.db });
      expect(plan.targets?.map((t) => t.serverId)).toEqual([SLAVE_ID]);
    }
  });

  it("refuses the master for the DISCONNECT only, naming what a disconnect would sever", async () => {
    const db = setup();
    // A disconnect takes a host off the private network and LEAVES it off — and the master's
    // in-cluster components reach every slave's kube-apiserver over exactly that network.
    await expect(DEFS["cluster-tailnet-disconnect"].plan({ serverId: MASTER_ID }, { db: db.db })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringMatching(/carries the master part[\s\S]*every slave's kube-apiserver/),
    });
    // The two kinds that PUT a membership back admit a master like any other machine of the
    // infrastructure. Reconnect needs no cluster row on a master, exactly as it needs none on a
    // slave — the master here carries none.
    await expect(DEFS["cluster-tailnet-reconnect"].plan({ serverId: MASTER_ID }, { db: db.db })).resolves.toBeTruthy();
    // And the READ admits it too, which is the whole reason it exists: a master's reading could
    // otherwise be refreshed only by a repair, and the cheapest of the three still re-dials its client.
    await expect(DEFS["cluster-tailnet-read"].plan({ serverId: MASTER_ID }, { db: db.db })).resolves.toBeTruthy();
  });

  it("admits the master to a rejoin: ONE target — its own, public — and a plan that claims no certificate work", async () => {
    const db = setup();
    // The rejoin's live-cluster guard resolves against the master's own cluster row.
    db.db.insert(clusters).values({
      id: "cls_m", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com", status: "active",
    }).run();
    const plan = await DEFS["cluster-tailnet-rejoin"].plan({ serverId: MASTER_ID }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual([ATTEST_TARGET_STEP, "rejoin", "read-membership"]);
    // ONE entry for the one server. The aux master entry every slave rejoin declares would here be
    // a SECOND entry for the same server, and the executor keys ONE transport per server
    // (executor/context.ts `declared`) — the second entry would override the public transport this
    // plan states, and every session would quietly open on the LAN address.
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets?.[0]).toMatchObject({ serverId: MASTER_ID, ownsHost: true, transport: "public" });
    expect(deriveServerLocks(plan.targets ?? [])).toEqual([{ resource: "server", key: MASTER_ID }]);
    // A MASTER RUNS THE SAME PROGRAM AS EVERY OTHER HOST, certificate work included. Measured on a
    // real machine: adding a tailnet address made MicroK8s's own apiserver-kicker log "cert
    // change detected", re-issue the serving certificate and restart the control plane seconds
    // after the join — which restarted Vault, brought it back SEALED, and degraded every workload
    // that reads a secret. The certificate step is what does that deliberately and waits for the node
    // to come back, instead of leaving it to happen after the run has reported success.
    expect(plan.summary).toContain("tailnet-rejoin");
    expect(plan.summary).toContain("198.51.100.4");
    expect(plan.summary).not.toContain("10.1.1.1:");
    expect(plan.summary).toContain("certificate work");
    expect(plan.warnings.join(" ")).toContain("re-signs");
  });

  it("refuses a rejoin on a host with no live cluster — the credential is minted per slave", async () => {
    const db = setup();
    db.db.update(clusters).set({ status: "planned" }).where(eq(clusters.id, "cls_1")).run();
    await expect(DEFS["cluster-tailnet-rejoin"].plan({ serverId: SLAVE_ID }, { db: db.db })).rejects.toMatchObject({ code: "VALIDATION" });
    // The other two need no cluster at all: their programs declare no answer a cluster row would
    // state, and they drive the client on the host and nothing else.
    await expect(DEFS["cluster-tailnet-disconnect"].plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
    await expect(DEFS["cluster-tailnet-reconnect"].plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
    await expect(DEFS["cluster-tailnet-read"].plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
  });

  it("the READ plans on a host with no cluster row and no reading at all — the host that has no other way to be read", async () => {
    const db = setup();
    // A host nothing has looked at: no cluster row, and the column default for a row no run has
    // reached. Until this run kind existed the only way to obtain a reading here was to REJOIN the
    // host — mint a credential, log it out, join it again and re-sign its serving certificate — to
    // learn a number that changes nothing.
    db.db.delete(clusters).where(eq(clusters.serverId, SLAVE_ID)).run();
    db.db.update(servers).set({ tailnetState: "unknown", tailnetJson: null }).where(eq(servers.id, SLAVE_ID)).run();

    const plan = await DEFS["cluster-tailnet-read"].plan({ serverId: SLAVE_ID }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual([ATTEST_TARGET_STEP, "read-membership"]);
    expect(plan.targets?.map((t) => t.serverId)).toEqual([SLAVE_ID]);
    // Nothing to weigh at approve: the host is left as it was found, so the plan warns about nothing
    // and its summary says what it does NOT do — the counter-fact to the three repairs' warnings.
    expect(plan.warnings).toEqual([]);
    expect(plan.summary).toContain("Nothing on the host is changed");
    for (const kind of ["cluster-tailnet-disconnect", "cluster-tailnet-reconnect", "cluster-tailnet-rejoin"] as const) {
      const other = await DEFS[kind].plan({ serverId: SLAVE_ID }, { db: db.db }).catch(() => null);
      expect(other?.warnings ?? ["refused"], kind).not.toEqual([]);
    }
  });
});
