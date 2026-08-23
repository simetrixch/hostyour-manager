import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { assertGuardsArmed } from "../../executor/guards.ts";
import { buildRegistry } from "./registry.ts";
import { getRun } from "../../executor/read.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { hardenPreflightForSlave, parsePreflightOutput } from "./preflight.ts";
import { hasHardFailure } from "../../../shared/preflight.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { credLabels, sealTokenOnce, newestCredId, statedTarget } from "./defs/deploy-slave.kit.ts";
import { deploySlaveSteps, SLAVE_INSTALL_INPUTS } from "./defs/deploy-slave.ts";
import { registerStep } from "./defs/deploy-slave.verify.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import type { AnyRunDefinition, Step, StepCtx, Cleanup } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, STEP_NAMES, HEALTHY_SLAVE_PREFLIGHT, MASTER_MARKING_YAML,
  scriptedHosts, makeHarness, disposeHarnesses, stepColumn, hostedStepCtx, bareStepCtx,
  drainToVerifyDeadline, drainToNextTimer,
  type Harness,
} from "./deploy-slave.fixture.ts";

// deploy-slave: plan shape, guards, the failure modes of everything that runs BEFORE the first
// program conversation, and the local steps driven directly (mark-slave's map write, the verify
// gates under fake timers, register's idempotence). Everything that starts a machine run — the
// journeys over the deployment programs, the credential handshake, the cleanups drill — lives in
// redeploy.ansiwise.test.ts, the ONE file that talks to a real `ansiwise-rest serve` (the engine's run
// root is per-drive, so two serve fixtures in parallel would share records and collide).

describe("deploy-slave run — plan, guards, failure modes", () => {
  afterEach(disposeHarnesses);

  /** The one secret every approve needs now: the programs raise their commands to root with it. */
  const elevationOnly = (): Record<string, Buffer> => ({ [ANSIWISE_ELEVATION_SECRET]: Buffer.from("root-pw") });

  /** One step out of the def's own list, for driving it directly. */
  function stepOf(h: Harness, name: string): Step {
    const def = buildRegistry({ db: h.db.db, platformRepo: h.platformRepo }).get("deploy-slave") as AnyRunDefinition;
    const step = def.steps({ ...PARAMS, tier: "rehearsal" }).find((s) => s.name === name);
    if (!step) throw new Error(`no step ${name}`);
    return step;
  }

  it("plans the program-driven step list over two declared targets with the declared locks, and asks for the elevation password + the answers nobody records", async () => {
    const { executor } = await makeHarness();
    const { plan } = await executor.plan("deploy-slave", PARAMS);
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(plan.targets).toEqual([
      { serverId: SLAVE_ID, ownsHost: true, label: "s1 (slave)" },
      { serverId: MASTER_ID, ownsHost: false, label: "m1 (master)" },
    ]);
    // The locks: both git branches + the master's Vault and kube surfaces.
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: "s1.example.com" },
      { resource: "git-branch", key: "m1.example.com" },
      { resource: "master-vault", key: "m" },
      { resource: "master-kube", key: "m" },
    ]);
    // The programs raise their commands to root with a password the caller hands over per run;
    // the inputs are what the programs declare and neither the inventory nor the map can state.
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.requiredInputs).toEqual(SLAVE_INSTALL_INPUTS);
    expect(plan.requiredInputs?.map((i) => i.field)).toEqual(
      ["committer_email", "letsencrypt_email", "letsencrypt_server", "lan_cidr", "storage_path", "storage_directory"],
    );
    expect(plan.summary).toContain("s1.example.com");
    expect(plan.summary).toContain("m1");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("detached");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to plan without a master server (the management plane has nowhere to live)", async () => {
    const { executor } = await makeHarness({ master: false });
    const err = await executor.plan("deploy-slave", PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/master/);
  });

  it("keeps steps({}) pure, program-step-shaped, starts with attest-target; guards.armed passes", async () => {
    const { db } = await makeHarness();
    const registry = buildRegistry({ db: db.db });
    const def = registry.get("deploy-slave") as AnyRunDefinition;
    expect(def.mutating).toBe(true);
    const a = def.steps({});
    const b = def.steps({});
    expect(a.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(a[0]?.name).toBe("attest-target");
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name)); // pure in params
    // The boot self-check (guards.armed → assertGuardsArmed) covers deploy-slave.
    expect(() => assertGuardsArmed(registry)).not.toThrow();
  });

  it("resolves every cleanup name the steps can register (abortWithCleanup's lookup path)", async () => {
    const { db } = await makeHarness();
    const def = buildRegistry({ db: db.db }).get("deploy-slave") as AnyRunDefinition;
    const names = (def.cleanups?.({ ...PARAMS, tier: "rehearsal" }) ?? []).map((c) => c.name);
    expect(names.sort()).toEqual(["microk8s-reset-slave", "remove-slave", "remove-slave-marking"]);
  });

  it("hard-fails attest-target when the server name is not the domain's first label (the split-brain guard)", async () => {
    // The platform keys every per-slave resource on the domain's FIRST LABEL while the run keys
    // them on server.name — a disagreement used to split the resources across two names and only
    // die minutes in. The guard fails BEFORE anything is allocated or mutated.
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", { ...PARAMS, domain: "s9.example.com" });
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    const error = stepColumn(db, runId, "attest-target", "error") ?? "";
    expect(error).toMatch(/slave name mismatch/);
    expect(error).toContain('server "s1"');   // both values named...
    expect(error).toContain('"s9"');
    expect(error).toContain("rename the inventory server"); // ...and the fix is actionable
    // Fails before the DNS probe / machine attest / allocation tx: nothing touched the host,
    // nothing was allocated.
    expect(hosts.log).toHaveLength(0);
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  it("hard-fails attest-target when the DNS wildcard does not resolve", async () => {
    const hosts = scriptedHosts({ dnsOut: "DNS_WILDCARD none" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "attest-target", "error")).toMatch(/DNS wildcard \*\.s1\.example\.com does not resolve/);
    // DNS fails BEFORE the tx — nothing was allocated
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  it("hard-fails attest-target when the box behind the address is NOT the machine we adopted", async () => {
    const hosts = scriptedHosts({ machineId: "ffffffffffffffffffffffffffffffff" });
    const { db, executor } = await makeHarness({ hosts, keystore: "keyfile" });
    // The row remembers the machine adopt saw; the box now answering reports another one.
    db.db.update(servers).set({ machineId: "abc123def4567890abc123def4567890" }).where(eq(servers.id, SLAVE_ID)).run();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "attest-target", "error")).toMatch(/not the machine we adopted/);
  });

  it("attest-target refuses a LIVE cluster and names the run kind that does this job", async () => {
    const { db, executor } = await makeHarness({ keystore: "keyfile" });
    db.db.insert(clusters).values({
      id: "cls_live", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "active", slaveId: 1,
    }).run();
    db.db.update(servers).set({ status: "healthy" }).where(eq(servers.id, SLAVE_ID)).run();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "attest-target", "error")).toMatch(/is the redeploy run kind/);
    // nothing moved: the row stays active and single
    const rows = db.db.select().from(clusters).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });

  it("redeploy refuses a server whose cluster is not live — that state is deploy-slave's to finish", async () => {
    const { db, executor } = await makeHarness({ keystore: "keyfile" });
    // No cluster row at all: nothing has a machine layer to rebuild yet.
    const err = await executor.plan("redeploy", { serverId: PARAMS.serverId }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/carries no cluster/);
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  it("slave-preflight blocks on the HARD policy: a bound port 80 (a mere WARN at adopt time)", async () => {
    const hosts = scriptedHosts({
      preflightOut: HEALTHY_SLAVE_PREFLIGHT.replace("CHECK port.80 PASS port 80 free", "CHECK port.80 WARN port 80 already bound"),
    });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "slave-preflight")?.status).toBe("failed");
    expect(stepColumn(db, runId, "slave-preflight", "error")).toMatch(/Port 80 free/);
    // onTerminal choreography: server freed, cluster parked planned with its slaveId
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("ready");
    const cluster = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(cluster?.status).toBe("planned");
    expect(cluster?.slaveId).toBe(1);
  });

  it("slave-preflight blocks when the master's Vault is unreachable from the slave", async () => {
    const hosts = scriptedHosts({ vaultCode: "000", vaultExit: 7 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "slave-preflight", "error")).toMatch(/Master Vault reachable/);
  });

  it("prepare-checkouts fails NAMED when the master's checkouts cannot be stood where the branch cut reads — no program starts, no map is written", async () => {
    const hosts = scriptedHosts({ checkoutsOut: "", checkoutsExit: 3 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "prepare-checkouts")?.status).toBe("failed");
    const error = stepColumn(db, runId, "prepare-checkouts", "error") ?? "";
    expect(error).toContain("origin/m1.example.com");   // the live tree's branch, named
    expect(error).toContain("product branch");          // the work tree's, named
    expect(error).toContain("then retry the run");      // the fix is actionable
    // Nothing downstream ran: no serve conversation was opened on either host, and the run was
    // parked by onTerminal with its ordinal kept.
    expect(hosts.log.filter((l) => l.command.includes("ansiwise"))).toHaveLength(0);
    expect(db.db.select().from(clusters).get()?.status).toBe("planned");
  });

  // ---- mark-slave, driven directly (the map write is the manager's own git act) ------------

  it("mark-slave composes the slave's map FROM the master's and writes it onto the books branch — one address for the map and the handshake", async () => {
    const h = await makeHarness({ marking: false }); // a fresh deploy: no slave map yet
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    const armed: Cleanup[] = [];
    const checkpoints: unknown[] = [];
    const ctx = hostedStepCtx(h, { registerCleanup: (c) => armed.push(c), checkpoint: (d) => checkpoints.push(d) });
    await stepOf(h, "mark-slave").run(ctx);

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain)) ?? "";
    // The slave part (what makes the slaves-appset dial it), the identity, and the inheritance —
    // every installation-wide value is the MASTER's, never asked a second time.
    for (const want of [
      "fqdn: s1.example.com", "stage: prod", "role: slave", "master: m1.example.com",
      // books-cluster is the slaves ApplicationSet's SELECTOR key — a map without it is
      // invisible to the generator.
      "books-cluster: m1.example.com",
      "apiHost: 100.64.0.11", "apiPort: 16443", "build-plane: m1.example.com",
      "unit-apex: example.com", "platform-domain: example.com",
      "alert-recipients: ops@example.com", "catalog-repo: acme/acme-catalog",
    ]) expect(map).toContain(want);
    // The short name is DERIVED from the fqdn — never stored.
    expect(map).not.toContain("name:");
    expect(armed.map((c) => c.name)).toEqual(["remove-slave-marking"]);
    expect(checkpoints.at(-1)).toEqual({ branch: PARAMS.domain, apiHost: "100.64.0.11", changed: true });

    // Idempotent: the same composition commits nothing the second time.
    const commits = h.platformRepo.commits.length;
    await stepOf(h, "mark-slave").run(ctx);
    expect(h.platformRepo.commits).toHaveLength(commits);
    expect(checkpoints.at(-1)).toEqual({ branch: PARAMS.domain, apiHost: "100.64.0.11", changed: false });
  });

  it("mark-slave keeps what another writer recorded: a standing release pin survives the rewrite", async () => {
    const h = await makeHarness({
      marking: [
        "fqdn: s1.example.com", "stage: prod", "role: slave", "build-plane: m1.example.com",
        "release: 1.0.0-stable-20260801120000", "master: m1.example.com", "apiHost: 100.64.0.11", "apiPort: 16443",
      ].join("\n") + "\n",
    });
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));
    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMarkingPath(PARAMS.domain)) ?? "";
    expect(map).toContain("release: 1.0.0-stable-20260801120000"); // set-pin's field, not this step's
    expect(map).toContain("unit-apex: example.com");               // the inheritance still landed
  });

  it("mark-slave in REDEPLOY mode arms NO cleanup — dropping the map part of a live slave cascades its teardown", async () => {
    const h = await makeHarness();
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "active", slaveId: 1,
    }).run();
    const steps = deploySlaveSteps(
      { target: statedTarget(SLAVE_ID, PARAMS.domain, "prod"), mode: "redeploy" },
      { platformRepo: h.platformRepo },
    );
    const armed: Cleanup[] = [];
    await steps.find((s) => s.name === "mark-slave")?.run(hostedStepCtx(h, { registerCleanup: (c) => armed.push(c) }));
    expect(armed).toEqual([]);
  });

  it("slaveCryptoGate: a real-tier slave is refused under the plaintext keystore", async () => {
    const { executor } = await makeHarness(); // no meta row ⇒ keystore.mode defaults plaintext
    const err = await executor.plan("deploy-slave", { ...PARAMS, tier: "real" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PLAN_REFUSED");
  });

  it("slaveCryptoGate: a SECOND slave is refused under the plaintext keystore", async () => {
    const { db, executor } = await makeHarness();
    db.db.insert(servers).values({ id: "srv_other", name: "s2", host: "s2.example.com", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_other", serverId: "srv_other", stage: "prod", domain: "s2.example.com", status: "active", slaveId: 7 }).run();
    const err = await executor.plan("deploy-slave", PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PLAN_REFUSED");
  });

  // ---- verify-slave (HARD vs SOFT), driven directly under fake timers ------------------------

  /** A harness whose rows are where verify-slave finds them mid-run. */
  async function verifyWorld(hostsOver: Parameters<typeof scriptedHosts>[0] = {}): Promise<Harness> {
    const hosts = scriptedHosts(hostsOver);
    const h = await makeHarness({ hosts });
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    return h;
  }

  async function expireVerify(h: Harness): Promise<unknown> {
    const step = stepOf(h, "verify-slave");
    vi.useFakeTimers();
    try {
      const outcome = step.run(hostedStepCtx(h)).then(() => undefined, (e: unknown) => e);
      await drainToVerifyDeadline();
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  }

  it("verify-slave HARD-fails when an app is not Synced (the bounded retry window expires), with the diagnostics taken", async () => {
    const h = await verifyWorld({ argoAppsOut: "root-applications|OutOfSync|Progressing\nplatform-apps-prod|Synced|Healthy" });
    const err = await expireVerify(h);
    expect(String((err as Error).message)).toMatch(/s1 applications Synced\+Healthy did not converge/);
    expect(String((err as Error).message)).toContain("root-applications (OutOfSync/Progressing)");
    // The master-side diagnostic bundle ran while the gate was failing AND right before the throw.
    expect(h.hosts.log.filter((l) => l.host === "m1.example.com" && l.command.includes("dc-slave-diag-")).length).toBeGreaterThanOrEqual(1);
  });

  it("verify-slave HARD gate 0: a never-Ready ExternalSecret fails NAMED, after force-sync kicks", async () => {
    const h = await verifyWorld({ externalSecretsOut: "cluster-slave|True|SecretSynced\nrepo-hostyour-cloud|False|SecretSyncedError" });
    const err = await expireVerify(h);
    expect(String((err as Error).message)).toMatch(/s1 ExternalSecrets Ready \(repo \+ cluster credentials\) did not converge/);
    expect(String((err as Error).message)).toContain("repo-hostyour-cloud (SecretSyncedError)");
    // The backoff-breaking kick fired on the master, and gate 1 was never reached.
    expect(h.hosts.log.some((l) => l.host === "m1.example.com" && l.command.includes("annotate externalsecrets.external-secrets.io --all force-sync="))).toBe(true);
    expect(h.hosts.log.some((l) => l.command.includes("get applications.argoproj.io"))).toBe(false);
  });

  it("verify-slave HARD-fails when a slave ESO SecretStore never reaches Ready", async () => {
    const h = await verifyWorld({ secretStoresOut: "external-secrets/vault-backend|True\nredis/vault-backend|False" });
    const err = await expireVerify(h);
    expect(String((err as Error).message)).toMatch(/slave ESO SecretStores Ready did not converge/);
    expect(String((err as Error).message)).toContain("redis/vault-backend");
  });

  it("verify-slave survives a transient SSH channel-open refusal mid-poll (MaxSessions pressure) and converges", async () => {
    // The recorded live failure's other half: a verify poll died on "(SSH) Channel open failure" —
    // the master's sshd refusing one more channel. The connection is alive and each poll frees its
    // channel, so a refused open must be a FAILING POLL (retried on the next cadence tick), never
    // a step death.
    const h = await verifyWorld();
    h.hosts.execFaults.push({ match: "get externalsecrets.external-secrets.io", message: "(SSH) Channel open failure: open failed" });
    const step = stepOf(h, "verify-slave");
    vi.useFakeTimers();
    try {
      const done = step.run(hostedStepCtx(h));
      await drainToNextTimer();
      await vi.advanceTimersByTimeAsync(15_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    // The faulted poll was consumed and the verify still converged on the next cadence tick.
    expect(h.hosts.execFaults).toHaveLength(0);
  });

  it("verify-slave degrades gracefully on the SOFT checks: no metrics + no certs still succeed", async () => {
    const h = await verifyWorld({ promOut: "PROM_CHECK empty", certsOut: "" });
    const checkpoints: unknown[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { checkpoint: (d) => checkpoints.push(d) }));
    expect(checkpoints.at(-1)).toEqual({ extSecrets: 2, apps: 2, secretStores: 2, prom: "empty", certsTotal: 0, certsReady: 0 });
  });

  // ---- register + the credential idioms -------------------------------------------------------

  it("register is overwrite-idempotent: re-running it converges (plane + provisionedAt stable)", async () => {
    const { db, store } = await makeHarness();
    // The world create-mgmt leaves behind: the row with the kube facts, the two sealed creds.
    db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
      planeJson: { kube: { server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" } },
    }).run();
    const ctx = bareStepCtx(db, store);
    const labels = credLabels("s1");
    await sealTokenOnce(ctx, { kind: "kubeconfig", label: labels.bearer, serverId: SLAVE_ID, token: "tok-bearer" });
    await sealTokenOnce(ctx, { kind: "other", label: labels.reviewer, serverId: SLAVE_ID, token: "tok-reviewer" });

    const register = registerStep(statedTarget(SLAVE_ID, PARAMS.domain, "prod"));
    await register.run(ctx);
    const before = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(before?.status).toBe("active");
    expect(before?.planeState).toBe("ready");
    expect(ClusterPlaneV0.parse(before?.planeJson).v).toBe(0);
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("healthy");

    await register.run(ctx); // what a crash-resumed executor does
    const after = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(after?.provisionedAt?.getTime()).toBe(before?.provisionedAt?.getTime()); // kept, not re-stamped
    expect(after?.planeJson).toEqual(before?.planeJson); // byte-stable plane
  });

  it("sealTokenOnce: a CHANGED token for the same label ROTATES the credential in place (retry-robust)", async () => {
    const { db, store } = await makeHarness();
    const lines: string[] = [];
    const ctx: StepCtx = { ...bareStepCtx(db, store), log: (_stream, text) => { lines.push(text); } };
    const label = credLabels("s1").bearer;
    const id1 = await sealTokenOnce(ctx, { kind: "kubeconfig", label, serverId: SLAVE_ID, token: "token-mint-one" });
    // the emit re-minted the token on the retry: same label, different bytes — must UPDATE
    // the logical credential, never blind-insert a duplicate
    const id2 = await sealTokenOnce(ctx, { kind: "kubeconfig", label, serverId: SLAVE_ID, token: "token-mint-two" });
    expect(id2).not.toBe(id1);
    const old = db.sqlite.prepare("SELECT rotated_at FROM credentials WHERE id=?").get(id1) as { rotated_at: number | null };
    expect(old.rotated_at).not.toBeNull(); // superseded row carries provenance
    // register's resolver (newest-by-label) finds the rotated-in credential
    expect(await newestCredId(ctx, { serverId: SLAVE_ID, kind: "kubeconfig", label })).toBe(id2);
    // the reuse fast-path stays intact, and every path logs its story
    expect(await sealTokenOnce(ctx, { kind: "kubeconfig", label, serverId: SLAVE_ID, token: "token-mint-two" })).toBe(id2);
    expect(lines.some((l) => l.includes(`credential "${label}" sealed`))).toBe(true);
    expect(lines.some((l) => l.includes("rotated in place"))).toBe(true);
    expect(lines.some((l) => l.includes("reusing"))).toBe(true);
  });

  it("sealTokenOnce: the SAME stable token under an OLD label no longer dies on the fingerprint index (the s1 incident)", async () => {
    // The live create-mgmt failure class: the slave's long-lived SA token is STABLE across runs;
    // a row sealed under the pre-rename label scheme holds the same fingerprint, the label
    // mismatch defeats the reuse fast-path, and the old GLOBAL unique index
    // credentials_fingerprint_uq rejected the fresh insert. Migration 0005 made the index
    // non-unique — the seal must now succeed.
    const { db, store } = await makeHarness();
    const token = "eyJhbGciOiJSUzI1NiJ9.stable-long-lived-sa-token.sig";
    const fp = "sha256:" + createHash("sha256").update(token, "utf8").digest("hex");
    await store.seal({
      kind: "kubeconfig", label: "edge1 cluster bearer (argocd-manager) — s1",
      plaintext: Buffer.from(token), fingerprint: fp, serverId: SLAVE_ID,
    });
    const ctx = bareStepCtx(db, store);
    const label = credLabels("s1").bearer;
    const id = await sealTokenOnce(ctx, { kind: "kubeconfig", label, serverId: SLAVE_ID, token });
    expect(await newestCredId(ctx, { serverId: SLAVE_ID, kind: "kubeconfig", label })).toBe(id);
  });

  it("hardenPreflightForSlave: every check hard; 80/443/snapd warns promoted to fails; adopt's view untouched", () => {
    const parsed = parsePreflightOutput([
      "CHECK os.ubuntu PASS ubuntu 26.04",
      "CHECK cpu.count WARN 2 cores (>=4 recommended)",
      "CHECK disk.free FAIL 10 GB free (<25)",
      "CHECK port.443 WARN port 443 already bound",
      "CHECK snapd.present WARN snapd missing",
      "CHECK time.sync WARN clock not NTP-synced",
    ].join("\n")).checks;

    const hard = hardenPreflightForSlave(parsed);
    const byId = new Map(hard.map((c) => [c.id, c]));
    expect(hard.every((c) => c.severity === "hard")).toBe(true);
    expect(byId.get("port.443")?.status).toBe("fail"); // promoted (Traefik must own it)
    expect(byId.get("port.443")?.hint).toBeDefined();
    expect(byId.get("snapd.present")?.status).toBe("fail"); // promoted (MicroK8s is a snap)
    expect(byId.get("cpu.count")?.status).toBe("warn"); // NOT in the promotion set
    expect(byId.get("time.sync")?.status).toBe("warn");
    expect(byId.get("disk.free")?.status).toBe("fail"); // soft-fail at adopt ⇒ blocks here
    expect(byId.get("os.ubuntu")?.status).toBe("pass");
    expect(hasHardFailure({ checkedAt: 0, checks: hard })).toBe(true);
    // pure: the input (what adopt persisted) keeps its soft severities
    expect(parsed.find((c) => c.id === "cpu.count")?.severity).toBe("soft");
  });

  it("the master's map is what mark-slave inherits from — MASTER_MARKING_YAML carries every field the composition reads", () => {
    // A fixture drift guard: the composition reads build-plane, unit-apex, platform-domain,
    // alert-recipients and catalog-repo off the master's map; a fixture that lost one would turn
    // the inheritance tests above green for the wrong reason.
    for (const key of ["build-plane", "unit-apex", "platform-domain", "alert-recipients", "catalog-repo"]) {
      expect(MASTER_MARKING_YAML).toContain(`${key}: `);
    }
  });
});
