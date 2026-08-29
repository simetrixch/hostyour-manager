import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { assertGuardsArmed } from "../../executor/guards.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { getRun } from "../../executor/read.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { hardenPreflightForSlave, parsePreflightOutput } from "./preflight.ts";
import { hasHardFailure } from "../../../shared/preflight.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { credLabels, sealTokenOnce, newestCredId, statedTarget } from "./defs/deploy-slave.kit.ts";
import { dataDiskFrom, SLAVE_INSTALL_INPUTS } from "./defs/deploy-slave.ts";
import { registerStep } from "./defs/deploy-slave.verify.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { AnyRunDefinition, StepCtx } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, STEP_NAMES, HEALTHY_SLAVE_PREFLIGHT, MASTER_MARKING_YAML,
  ELEVATION_PASSWORD, scriptedHosts, makeHarness, disposeHarnesses, hostedStepCtx, bareStepCtx,
  drainToVerifyDeadline, drainToNextTimer, stepOf,
  type Harness,
} from "./deploy-slave.fixture.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";

// deploy-slave: plan shape, guards, the failure modes of everything that runs BEFORE the first
// program conversation, and the local steps driven directly (mark-slave's map write, the verify
// gates under fake timers, register's idempotence). Everything that starts a machine run — the
// journeys over the deployment programs, the credential handshake, the cleanups drill — lives in
// redeploy.ansiwise.test.ts, the ONE file that talks to a real `ansiwise-rest serve` (the engine's run
// root is per-drive, so two serve fixtures in parallel would share records and collide).

describe("deploy-slave run — plan, guards, failure modes", () => {
  afterEach(disposeHarnesses);

  /** The one secret every approve needs now: the programs raise their commands to root with it. */
  const elevationOnly = (): Record<string, Buffer> => ({ [ANSIWISE_ELEVATION_SECRET]: Buffer.from(ELEVATION_PASSWORD) });

  it("plans the program-driven step list over two declared targets with the declared locks, and asks for the elevation password + the answers nobody records", async () => {
    const { executor } = await makeHarness();
    const { plan } = await executor.plan("cluster-deploy-slave", PARAMS);
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
      [],
    );
    expect(plan.summary).toContain("s1.example.com");
    expect(plan.summary).toContain("m1");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("detached");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to plan without a master server (the management plane has nowhere to live)", async () => {
    const { executor } = await makeHarness({ master: false });
    const err = await executor.plan("cluster-deploy-slave", PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/master/);
  });

  it("keeps steps({}) pure, program-step-shaped, starts with attest-target; guards.armed passes", async () => {
    const { db } = await makeHarness();
    const runDefinitions = buildRunDefinitions({ db: db.db });
    const def = runDefinitions.get("cluster-deploy-slave") as AnyRunDefinition;
    expect(def.mutating).toBe(true);
    const a = def.steps({});
    const b = def.steps({});
    expect(a.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(a[0]?.name).toBe("attest-target");
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name)); // pure in params
    // The boot self-check (guards.armed → assertGuardsArmed) covers deploy-slave.
    expect(() => assertGuardsArmed(runDefinitions)).not.toThrow();
  });

  it("resolves every cleanup name the steps can register (abortWithCleanup's lookup path)", async () => {
    const { db } = await makeHarness();
    const def = buildRunDefinitions({ db: db.db }).get("cluster-deploy-slave") as AnyRunDefinition;
    const names = (def.cleanups?.({ ...PARAMS, tier: "rehearsal" }) ?? []).map((c) => c.name);
    expect(names.sort()).toEqual(["microk8s-reset-slave", "remove-slave", "remove-slave-marking"]);
  });

  it("hard-fails attest-target when the server name is not the domain's first label (the split-brain guard)", async () => {
    // The platform keys every per-slave resource on the domain's FIRST LABEL while the run keys
    // them on server.name — a disagreement used to split the resources across two names and only
    // die minutes in. The guard fails BEFORE anything is allocated or mutated.
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("cluster-deploy-slave", { ...PARAMS, domain: "s9.example.com" });
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
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
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
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
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
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
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
    const err = await executor.plan("cluster-redeploy", { serverId: PARAMS.serverId }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/carries no cluster/);
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  // The whole refusal, end to end, in the shape the field produced it: a machine already serving
  // ingress through a DNAT — nothing listening on 80, and a connection to its own address accepted.
  // That is a WARN at adopt time and a hard refusal here, and it is the machine a second installation
  // must not be laid over.
  it("slave-preflight blocks on the HARD policy: port 80 served with no listener (a mere WARN at adopt time)", async () => {
    const hosts = scriptedHosts({
      preflightOut: HEALTHY_SLAVE_PREFLIGHT.replace("PORT 80 listener=no connect=no", "PORT 80 listener=no connect=203.0.113.7"),
    });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
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
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
    await executor.approve(runId, elevationOnly());
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "slave-preflight", "error")).toMatch(/Master Vault reachable/);
  });

  it("prepare-checkouts fails NAMED when the master's checkouts cannot be stood where the branch cut reads — no program starts, no map is written", async () => {
    const hosts = scriptedHosts({ checkoutsOut: "", checkoutsExit: 3 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("cluster-deploy-slave", PARAMS);
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

  it("slaveCryptoGate: a real-tier slave is refused under the plaintext keystore", async () => {
    const { executor } = await makeHarness(); // no meta row ⇒ keystore.mode defaults plaintext
    const err = await executor.plan("cluster-deploy-slave", { ...PARAMS, tier: "real" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PLAN_REFUSED");
  });

  it("slaveCryptoGate: a SECOND slave is refused under the plaintext keystore", async () => {
    const { db, executor } = await makeHarness();
    db.db.insert(servers).values({ id: "srv_other", name: "s2", host: "s2.example.com", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_other", serverId: "srv_other", stage: "prod", domain: "s2.example.com", status: "active", slaveId: 7 }).run();
    const err = await executor.plan("cluster-deploy-slave", PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PLAN_REFUSED");
  });

  // ---- verify-slave (HARD vs SOFT), driven directly under fake timers ------------------------

  /** A harness whose rows are where verify-slave finds them mid-run. */
  async function verifyWorld(hostsOver: Parameters<typeof scriptedHosts>[0] = {}): Promise<Harness> {
    const h = await makeHarness({ hosts: scriptedHosts(hostsOver) });
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
    const h = await verifyWorld({ externalSecretsOut: "cluster-slave|True|SecretSynced\nrepo-platform|False|SecretSyncedError" });
    const err = await expireVerify(h);
    expect(String((err as Error).message)).toMatch(/s1 ExternalSecrets Ready \(repo \+ cluster credentials\) did not converge/);
    expect(String((err as Error).message)).toContain("repo-platform (SecretSyncedError)");
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
      // The reading a machine already serving ingress produces: no listening socket, and a connection
      // to its own address accepted anyway.
      "PORT 443 listener=no connect=203.0.113.7",
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
    // A fixture drift guard: the composition reads buildPlane, unitApex, platformDomain,
    // alertRecipients and catalogUrl off the master's map; a fixture that lost one would turn
    // the inheritance tests above green for the wrong reason.
    for (const key of ["buildPlane", "unitApex", "platformDomain", "alertRecipients", "catalogUrl"]) {
      expect(MASTER_MARKING_YAML).toContain(`${key}: `);
    }
  });
});

describe("dataDiskFrom", () => {
  // THE TABLE A MASTER ACTUALLY ANSWERED WITH, shortened only where it repeats. 29 GB of cluster
  // data sat on /dev/sda2 while /dev/sdb1 held 2.1 MB, because the three rows that place the
  // volumes each do nothing when the answer is empty and nobody had been asked for one
  // (2026-08-29).
  const APPS3 = [
    "/ /dev/sda2 ext4",
    "/boot/efi /dev/sda1 vfat",
    "/mnt/data /dev/sdb1 ext4",
    "/var/snap/microk8s/common/var/lib/kubelet/pods/1057/volume-subpaths/empty-dir/postgresql/0 /dev/sda2[/x] ext4",
    "/var/snap/microk8s/common/var/lib/kubelet/pods/faf7/volume-subpaths/pvc-2671/postfix/0 /dev/sda2[/y] ext4",
  ].join(String.fromCharCode(10));

  it("finds the separate disk and names a directory on it", () => {
    expect(dataDiskFrom(APPS3)).toEqual({
      storage_mount: "/mnt/data",
      storage_subdirectory: "/mnt/data/microk8s-storage",
    });
  });

  it("never takes a mount the container runtime made, which is the cluster's own volumes", () => {
    // THE DANGEROUS ONE. Those lines are on the BOOT disk and they are mounts, so a reading that
    // asked only "is it a mount of a block device" would point the storage at what it stores.
    const runtimeOnly = APPS3.split(String.fromCharCode(10)).filter((l) => !l.startsWith("/mnt")).join(String.fromCharCode(10));
    expect(dataDiskFrom(runtimeOnly)).toBeUndefined();
  });

  it("answers nothing for a machine that carries one disk", () => {
    expect(dataDiskFrom("/ /dev/sda2 ext4")).toBeUndefined();
  });

  it("takes the shallowest of several, because a nested mount is part of the disk above it", () => {
    const nested = ["/ /dev/sda2 ext4", "/mnt/data/inner /dev/sdc1 ext4", "/mnt/data /dev/sdb1 ext4"].join(String.fromCharCode(10));
    expect(dataDiskFrom(nested)?.storage_mount).toBe("/mnt/data");
  });
});
