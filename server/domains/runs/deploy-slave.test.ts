import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { assertGuardsArmed } from "../../executor/guards.ts";
import { buildRegistry } from "./registry.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { hardenPreflightForSlave, parsePreflightOutput } from "./preflight.ts";
import { hasHardFailure } from "../../../shared/preflight.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { credLabels, sealTokenOnce, newestCredId, APP_SYNC_POLL_MS } from "./defs/deploy-slave.kit.ts";
import { clusterMarkingPath } from "../inventory/cluster-marking.ts";
import type { AnyRunDefinition, StepCtx } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, STEP_NAMES, HEALTHY_SLAVE_PREFLIGHT,
  scriptedHosts, makeHarness, disposeHarnesses, stepColumn,
  drainToVerifyDeadline, drainToNextTimer, bareStepCtx,
} from "./deploy-slave.fixture.ts";

// deploy-slave: plan shape, guards, and the per-step failure
// modes + the verify/register gates. The green 0→7 journey and the lifecycle drills
// (cleanups, resume, machine-id) live in deploy-slave.journey.test.ts; the two steps that
// refuse a run whose cluster map and creds blob name different addresses in
// deploy-slave.address.test.ts; the composed install.sh line (parser contract + the values
// threaded off the master's map) in deploy-slave.installer.test.ts; the shared two-host
// hosts fixture in deploy-slave.fixture.ts.

describe("deploy-slave run — plan, guards, failure modes", () => {
  afterEach(disposeHarnesses);

  it("plans 9 steps over two declared targets with the declared locks; NO required secrets (the PAT is Vault-sourced)", async () => {
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
    // The PAT auto-sources from the platform Vault — approval needs NO secret and there is
    // no manual override anymore (the Vault is the single source; the warning says so).
    expect(plan.requiredSecrets).toEqual([]);
    expect(plan.summary).toContain("s1.example.com");
    expect(plan.summary).toContain("m1");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("GITOPS_REPO_PAT");
    expect(plan.warnings[0]).toContain("no manual entry at approval");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to plan without a master server (the management plane has nowhere to live)", async () => {
    const { executor } = await makeHarness({ master: false });
    const err = await executor.plan("deploy-slave", PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/master/);
  });

  it("keeps steps({}) pure, 9-step-shaped, starts with attest-target; guards.armed passes", async () => {
    const { db } = await makeHarness();
    const registry = buildRegistry({ db: db.db });
    const def = registry.get("deploy-slave") as AnyRunDefinition;
    expect(def.mutating).toBe(true);
    const a = def.steps({});
    const b = def.steps({});
    expect(a).toHaveLength(9);
    expect(a[0]?.name).toBe("attest-target");
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name)); // pure in params
    // The boot self-check (guards.armed → assertGuardsArmed) covers deploy-slave.
    expect(() => assertGuardsArmed(registry)).not.toThrow();
  });

  it("hard-fails attest-target when the server name is not the domain's first label (the split-brain guard)", async () => {
    // The installer keys every per-slave resource on the domain's FIRST LABEL
    // (slave.sh: ${fqdn%%.*}) while the run keys the pointer/Application/project/ES paths on
    // server.name — a disagreement used to split the resources across two names and only die
    // at step 5/6 after ~20 min. The guard fails BEFORE anything is allocated.
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", { ...PARAMS, domain: "s9.example.com" });
    await executor.approve(runId);
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
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "attest-target", "error")).toMatch(/DNS wildcard \*\.s1\.example\.com does not resolve/);
    // DNS fails BEFORE the tx — nothing was allocated
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  it("slave-preflight blocks on the HARD policy: a bound port 80 (a mere WARN at adopt time)", async () => {
    const hosts = scriptedHosts({
      preflightOut: HEALTHY_SLAVE_PREFLIGHT.replace("CHECK port.80 PASS port 80 free", "CHECK port.80 WARN port 80 already bound"),
    });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
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
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(stepColumn(db, runId, "slave-preflight", "error")).toMatch(/Master Vault reachable/);
  });

  it("prepare-branch fails when install.sh does not report the scaffolded secrets path", async () => {
    const hosts = scriptedHosts({ prepareOut: "some unrelated output" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.steps.find((s) => s.name === "prepare-branch")?.status).toBe("failed");
    expect(stepColumn(db, runId, "prepare-branch", "error")).toMatch(/secrets path/);
  });

  it("prepare-branch fails NAMED when the master's map carries no catalog-repo — nothing reaches the master", async () => {
    // A slave belongs to the same installation, so its map is composed from the MASTER's. Of the
    // values it inherits, catalog-repo is the one that must be there: set-role.sh runs on the
    // slave's OWN branch and dies outright without it — which is ten minutes in, with the branch
    // already cut and pushed. So the map is read BEFORE any shell reaches the master, and a map
    // missing the field fails here, naming the file and what to put into it.
    const { db, executor, hosts, platformRepo } = await makeHarness();
    platformRepo.seed(platformRepo.booksBranch, clusterMarkingPath("m1.example.com"),
      "fqdn: m1.example.com\nstage: prod\nrole: master\nbuild-plane: m1.example.com\n");
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "prepare-branch")?.status).toBe("failed");
    const error = stepColumn(db, runId, "prepare-branch", "error") ?? "";
    expect(error).toContain("clusters/active/m1.example.com.yaml"); // the file, named
    expect(error).toContain("catalog-repo");                        // the field, named
    expect(error).toContain("then retry the run");                  // the fix is actionable
    // The master never saw the prepare-branch shell, and the map cleanup was never armed —
    // the refusal precedes both, so there is nothing to undo.
    expect(hosts.log.some((l) => l.command.includes("dc-prepare-branch-"))).toBe(false);
    const cp = JSON.parse(stepColumn(db, runId, "prepare-branch", "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
    expect(cp.__cleanups).toBeUndefined();
  });

  it("mint-join-key fails when the master emits no valid blob, and the raw output never rides the error", async () => {
    // A mint that "succeeded" but printed something else means the master ran installer code
    // that does not know the flag, or its coordinator answered with nothing. Either way the
    // slave would be handed no credential — and the raw stdout must not travel into the
    // persisted step error, because on the happy path that string IS the key.
    const hosts = scriptedHosts({ mintOut: "not json at all" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "mint-join-key")?.status).toBe("failed");
    const error = stepColumn(db, runId, "mint-join-key", "error") ?? "";
    expect(error).toContain("valid tailnet join-credential JSON blob");
    expect(error).not.toContain("not json at all");
    // Nothing downstream ran: no base install, no key staged on the slave.
    expect(hosts.log.some((l) => l.command.endsWith("./setup.sh --prod"))).toBe(false);
    expect(hosts.files.some((x) => x.path.includes("dc-tailnet-authkey-"))).toBe(false);
  });

  it("a slave that cannot join the tailnet FAILS THERE — create-mgmt never runs", async () => {
    // The failure this ticket exists to prevent is the quiet one: the install finishes, the
    // slave looks deployed, and the first sign of trouble is the master's ArgoCD unable to
    // reach it at all. The join is a hard gate inside the bring-up instead.
    const hosts = scriptedHosts({ tailnetJoinExit: 1 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "install-microk8s")?.status).toBe("failed");
    expect(stepColumn(db, runId, "install-microk8s", "error") ?? "").toContain("could not join the tailnet");
    expect(hosts.log.some((l) => l.command.includes("--emit-mgmt-credentials"))).toBe(false);
    expect(hosts.log.some((l) => l.command.includes("--slave-add"))).toBe(false);
    // The staged key is removed even on the failing path — it does not outlive the step.
    expect(hosts.log.some((l) => l.command === `rm -f /tmp/dc-tailnet-authkey-${runId}`)).toBe(true);
  });

  it("mint-join-key fails NAMED when the master's ~/hostyour-cloud refresh fails — no master-side setup.sh runs from a stale tree", async () => {
    // The stale-master guard's failure mode: the refresh could not converge the master's live
    // checkout onto origin/<masterFqdn> (missing .git ⇒ exit 3; a failed fetch/reset/checkout ⇒
    // its own non-zero). The step must fail FAST — before the slave's ~25-min base install —
    // with the host + branch named, and no master-side setup.sh may run.
    const hosts = scriptedHosts({ masterRefreshOut: "", masterRefreshExit: 3 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "mint-join-key")?.status).toBe("failed");
    const error = stepColumn(db, runId, "mint-join-key", "error") ?? "";
    expect(error).toContain("origin/m1.example.com");     // the branch, named
    expect(error).toContain("on m1.example.com");         // the host, named
    expect(error).toContain("then retry the run");               // the fix is actionable
    // Fails fast and safe: no master-side setup.sh from a stale tree, no base install wasted.
    expect(hosts.log.some((l) => l.command.includes("--tailnet-mint-join-key"))).toBe(false);
    expect(hosts.log.some((l) => l.command.includes("--slave-add"))).toBe(false);
    expect(hosts.log.some((l) => l.command.includes("--emit-mgmt-credentials"))).toBe(false);
  });

  it("create-mgmt fails STATICALLY (no output echo) when the slave emits an invalid blob", async () => {
    const hosts = scriptedHosts({ emitOut: '{"server": "https://10.1.1.11:16443", "oops": true}' });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.steps.find((s) => s.name === "create-mgmt")?.status).toBe("failed");
    const error = stepColumn(db, runId, "create-mgmt", "error") ?? "";
    expect(error).toMatch(/did not emit a valid management-credentials JSON blob/);
    expect(error).not.toContain("oops"); // the raw output never rides an error message
  });

  it("install-microk8s fails NAMED when the Vault auto-source fails (the Vault is the only source)", async () => {
    const hosts = scriptedHosts({ repoPatOut: "", repoPatExit: 3 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "install-microk8s")?.status).toBe("failed");
    const error = stepColumn(db, runId, "install-microk8s", "error") ?? "";
    expect(error).toContain("GITOPS_REPO_PAT");
    expect(error).toContain("secret/prod/system/argocd:repo-pat");
    expect(error).toContain("then retry the run"); // the fix is actionable: repair the Vault, retry
    // The PAT never existed: no askpass helper was ever delivered to the slave.
    expect(hosts.files.some((x) => x.path.includes("dc-askpass-"))).toBe(false);
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

  // ---- verify-slave (HARD vs SOFT) + register --------------------------------------

  it("verify-slave HARD-fails when an app is not Synced (the bounded retry window expires)", async () => {
    const hosts = scriptedHosts({ argoAppsOut: "root-applications|OutOfSync|Progressing\nplatform-apps-prod|Synced|Healthy" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    vi.useFakeTimers();
    try {
      await executor.approve(runId);
      await drainToVerifyDeadline();
    } finally {
      vi.useRealTimers();
    }
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "verify-slave")?.status).toBe("failed");
    const error = stepColumn(db, runId, "verify-slave", "error") ?? "";
    expect(error).toMatch(/s1 applications Synced\+Healthy did not converge/);
    expect(error).toContain("root-applications (OutOfSync/Progressing)");
    expect(error).toContain("diagnostics in the run log above");
    // The master-side diagnostic bundle ran while the gate was failing AND right before the
    // throw, and its output landed in the run log (the first live run had none of this).
    expect(hosts.log.filter((l) => l.host === "m1.example.com" && l.command.includes("dc-slave-diag-")).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(readEvents(db.db, runId))).toContain("verify-slave diagnostics (ns s1)");
    // parked mid-verify: onTerminal freed the server + parked the cluster (slaveId KEPT)
    const cluster = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(cluster?.status).toBe("planned");
    expect(cluster?.planeState).toBe("verifying");
    expect(cluster?.slaveId).toBe(1);
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("ready");
  });

  it("verify-slave HARD gate 0: a never-Ready ExternalSecret fails NAMED, after force-sync kicks", async () => {
    // The recorded live failure's signature (root-applications Unknown/Unknown for ~14 min)
    // pointed at the instance's repo credential never materializing. Gate 0 now reports THAT
    // directly: the ES name + Ready reason ride the step error, and the step kicked ESO's
    // error backoff with the chart's force-sync annotation idiom on the way.
    const hosts = scriptedHosts({ externalSecretsOut: "cluster-slave|True|SecretSynced\nrepo-hostyour-cloud|False|SecretSyncedError" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    vi.useFakeTimers();
    try {
      await executor.approve(runId);
      await drainToVerifyDeadline();
    } finally {
      vi.useRealTimers();
    }
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("failed");
    const error = stepColumn(db, runId, "verify-slave", "error") ?? "";
    expect(error).toMatch(/s1 ExternalSecrets Ready \(repo \+ cluster credentials\) did not converge/);
    expect(error).toContain("repo-hostyour-cloud (SecretSyncedError)");
    // The backoff-breaking kick and the diagnostic bundle both fired on the master.
    expect(hosts.log.some((l) => l.host === "m1.example.com" && l.command.includes("annotate externalsecrets.external-secrets.io --all force-sync="))).toBe(true);
    expect(hosts.log.some((l) => l.host === "m1.example.com" && l.command.includes("dc-slave-diag-"))).toBe(true);
    // ...and gate 1 was never reached: the apps poll must not have run.
    expect(hosts.log.some((l) => l.command.includes("get applications.argoproj.io"))).toBe(false);
  });

  it("verify-slave HARD-fails when a slave ESO SecretStore never reaches Ready", async () => {
    const hosts = scriptedHosts({ secretStoresOut: "external-secrets/vault-backend|True\nredis/vault-backend|False" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    vi.useFakeTimers();
    try {
      await executor.approve(runId);
      await drainToVerifyDeadline();
    } finally {
      vi.useRealTimers();
    }
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    const error = stepColumn(db, runId, "verify-slave", "error") ?? "";
    expect(error).toMatch(/slave ESO SecretStores Ready did not converge/);
    expect(error).toContain("redis/vault-backend");
  });

  it("verify-slave survives a transient SSH channel-open refusal mid-poll (MaxSessions pressure) and converges", async () => {
    // The recorded live failure's OTHER half: the final verify poll died on
    // "(SSH) Channel open failure: open failed" — the master's sshd refusing one more
    // channel. The connection is alive and each poll frees its channel, so a refused open
    // must be a FAILING POLL (retried on the next cadence tick), never a step death.
    const hosts = scriptedHosts();
    hosts.execFaults.push({ match: "get externalsecrets.external-secrets.io", message: "(SSH) Channel open failure: open failed" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    vi.useFakeTimers();
    try {
      await executor.approve(runId);
      // The refused HARD-gate-0 probe schedules the retry sleep; one cadence tick later the
      // fault is consumed and the whole verify converges on scripted microtasks alone.
      await drainToNextTimer();
      await vi.advanceTimersByTimeAsync(APP_SYNC_POLL_MS + 1_000);
    } finally {
      vi.useRealTimers();
    }
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    const events = JSON.stringify(readEvents(db.db, runId));
    expect(events).toContain("transient SSH channel refusal");
    expect(events).toContain("Channel open failure");
  });

  it("verify-slave degrades gracefully on the SOFT checks: no metrics + no certs still succeed", async () => {
    const hosts = scriptedHosts({ promOut: "PROM_CHECK empty", certsOut: "" });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    const events = JSON.stringify(readEvents(db.db, runId));
    expect(events).toContain("obs-agent push may still be warming up");
    expect(events).toContain("no Certificates on the slave yet");
    const cp = JSON.parse(stepColumn(db, runId, "verify-slave", "checkpoint_json") ?? "{}") as {
      data?: { extSecrets?: number; apps?: number; secretStores?: number; prom?: string; certsTotal?: number; certsReady?: number };
    };
    expect(cp.data).toEqual({ extSecrets: 2, apps: 2, secretStores: 2, prom: "empty", certsTotal: 0, certsReady: 0 });
  });

  it("register is overwrite-idempotent: re-running step 7 converges (plane + provisionedAt stable)", async () => {
    const { db, executor, store } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    const before = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(before?.status).toBe("active");

    // Re-execute register directly — what a crash-resumed executor does after the last step had
    // already committed its tx (steps are idempotent by contract).
    const def = buildRegistry({ db: db.db }).get("deploy-slave") as AnyRunDefinition;
    const steps = def.steps({ ...PARAMS, tier: "rehearsal" });
    const register = steps[steps.length - 1];
    await register?.run(bareStepCtx(db, store));

    const after = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(after?.status).toBe("active");
    expect(after?.planeState).toBe("ready");
    expect(after?.provisionedAt?.getTime()).toBe(before?.provisionedAt?.getTime()); // kept, not re-stamped
    expect(after?.planeJson).toEqual(before?.planeJson); // byte-stable plane
    expect(ClusterPlaneV0.parse(after?.planeJson).v).toBe(0);
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("healthy");
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
    // step 7's resolver (newest-by-label) finds the rotated-in credential
    expect(await newestCredId(ctx, { serverId: SLAVE_ID, kind: "kubeconfig", label })).toBe(id2);
    // the reuse fast-path stays intact, and every path logs its story
    expect(await sealTokenOnce(ctx, { kind: "kubeconfig", label, serverId: SLAVE_ID, token: "token-mint-two" })).toBe(id2);
    expect(lines.some((l) => l.includes(`credential "${label}" sealed`))).toBe(true);
    expect(lines.some((l) => l.includes("rotated in place"))).toBe(true);
    expect(lines.some((l) => l.includes("reusing"))).toBe(true);
  });

  it("sealTokenOnce: the SAME stable token under an OLD label no longer dies on the fingerprint index (the s1 incident)", async () => {
    // The live create-mgmt part-3 failure class: the slave's long-lived SA token is STABLE
    // across runs; a row sealed under the pre-rename label scheme holds the same fingerprint,
    // the label mismatch defeats the reuse fast-path, and the old GLOBAL unique index
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
});
