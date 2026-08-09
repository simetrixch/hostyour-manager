import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildRegistry } from "./registry.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { readServerTailnet } from "../../../shared/tailnet.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import {
  SLAVE_ID, PARAMS, STEP_NAMES, VAULT_PAT, EMIT_ARGOCD_TOKEN, EMIT_REVIEWER_TOKEN, MINT_AUTHKEY, SLAVE_MARKING_YAML,
  TAILNET_ADDRESS, TAILNET_COORDINATOR,
  scriptedHosts, makeHarness, disposeHarnesses, stepColumn, drainToVerifyDeadline,
} from "./deploy-slave.fixture.ts";

// deploy-slave, the GREEN paths + lifecycle:
// the full 0→7 journey with the exact per-host command choreography, redaction, the
// idempotence paths, the cleanup drill and the resume/machine-id lifecycle. Plan shape and
// per-step failure modes live in deploy-slave.test.ts.

describe("deploy-slave run — the full journey + lifecycle", () => {
  afterEach(disposeHarnesses);

  it("runs the FULL 0→7 journey: succeeded, cluster ACTIVE with a valid ClusterPlaneV0, server healthy", async () => {
    const { db, executor, store, hosts, platformRepo } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    const status = new Map(run?.steps.map((s) => [s.name, s.status]));
    for (const name of STEP_NAMES) expect(status.get(name), name).toBe("ok");

    // ---- register's terminal choreography: cluster active + plane v0.
    const cluster = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(cluster?.serverId).toBe(SLAVE_ID);
    expect(cluster?.slaveId).toBe(1);
    expect(cluster?.status).toBe("active");
    expect(cluster?.tier).toBe("rehearsal"); // zod default
    expect(cluster?.planeState).toBe("ready");
    expect(cluster?.provisionedAt).toBeInstanceOf(Date);
    const server = db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect(server?.status).toBe("healthy");
    expect(server?.machineId).toBe(hosts.machineId); // the machine-id backfill

    // The reading a LIVE slave carries is the one install-microk8s took AFTER the join. Adopt's
    // runs before the base install has put the client on the box, so it says "no client" — without
    // this second one every deployed slave would show that forever, about the machine the master's
    // ArgoCD and Vault are talking to.
    expect(server?.tailnetState).toBe("joined");
    const reading = readServerTailnet(server?.tailnetJson);
    expect(reading.kind === "v0" && reading.facts).toEqual(
      expect.objectContaining({ address: TAILNET_ADDRESS, coordinator: TAILNET_COORDINATOR, runId }),
    );

    // The stored plane parses back through the shared schema with the exact
    // <name>-based names and the step-4 credential IDs.
    const bearer = await store.list({ serverId: SLAVE_ID, kind: "kubeconfig" });
    const reviewer = await store.list({ serverId: SLAVE_ID, kind: "other" });
    expect(bearer).toHaveLength(1);
    expect(reviewer).toHaveLength(1);
    const plane = ClusterPlaneV0.parse(cluster?.planeJson);
    expect(plane).toEqual({
      v: 0,
      branch: "s1.example.com",
      slaveId: 1,
      vault: { addr: "https://vault.m1.example.com", kvMount: "s1", k8sAuthPath: "kubernetes-s1", policy: "s1-eso" },
      argo: { namespace: "s1", appName: "s1-apps" },
      // create-mgmt sealed the slave's kube-access facts into the plane (caData was previously
      // DROPPED): the exact API server URL the emit reported + the base64 CA bundle — the
      // resolver builds a per-cluster kube client from these + the sealed clusterBearer.
      kube: { server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" },
      credentialIds: { clusterBearer: bearer[0]?.id, reviewerJwt: reviewer[0]?.id },
      hostnames: { kube: "kube-s1.m1.example.com" },
    });

    // ---- The EXACT ordered remote command sequence per host (rm-cleanup lines filtered:
    // remoteScript's /tmp script removal, the askpass removal, the creds-file removal).
    const cmds = (host: string): string[] =>
      hosts.log.filter((l) => l.host === host && !l.command.startsWith("rm -f")).map((l) => l.command);
    expect(cmds("10.1.1.11")).toEqual([
      expect.stringContaining("dc-dns-probe-"),                                           // attest-target
      "cat /etc/machine-id",                                                              // attest-target
      expect.stringContaining("dc-slave-preflight-"),                                     // slave-preflight
      expect.stringContaining("/v1/sys/health"),                                          // slave-preflight: vault-from-slave
      expect.stringContaining("dc-clone-slave-"),                                         // install-microk8s: clone-or-refresh (ALWAYS, before the probe)
      expect.stringContaining("sudo -n microk8s status --wait-ready --timeout 5 >/dev/null 2>&1"), // install-microk8s: probe (base install only; dir resolved dynamically)
      expect.stringContaining('cd "$GITOPS_DIR" && sudo -n ./setup.sh --prod'),           // install-microk8s: base install (repo dir discovered, not hardcoded)
      "sudo -n microk8s kubectl wait --for=condition=Ready node --all --timeout=180s",    // install-microk8s: verify
      "sudo -n microk8s kubectl get clusterissuers.cert-manager.io -o name | grep -q .",  // install-microk8s: verify
      expect.stringContaining(`sudo -n ./setup.sh --prod --tailnet-join --tailnet-join-key-file /tmp/dc-tailnet-authkey-${runId}`), // install-microk8s: join (OUTSIDE the probe-gated phase)
      expect.stringContaining("dc-tailnet-probe-"),                                       // install-microk8s: read the membership back off the host, AFTER the join
      expect.stringContaining('cd "$GITOPS_DIR" && sudo -n ./setup.sh --prod --emit-mgmt-credentials --api-host 100.64.0.11'), // create-mgmt: harvest (the dial address STATED, never guessed)
      expect.stringContaining("get secretstores.external-secrets.io"),                    // verify-slave: HARD gate 2
      expect.stringContaining("get certificates.cert-manager.io"),                        // verify-slave: soft certs
    ]);
    expect(cmds("m1.example.com")).toEqual([
      expect.stringContaining("dc-prepare-branch-"),                                      // prepare-branch
      expect.stringContaining("dc-refresh-checkout-"),                                    // mint-join-key: live-checkout refresh (before ANY master-side setup.sh)
      expect.stringContaining('cd "$GITOPS_DIR" && sudo -n ./setup.sh --prod --tailnet-mint-join-key s1.example.com'), // mint-join-key
      expect.stringContaining("dc-fetch-repo-pat-"),                                      // install-microk8s: Vault PAT auto-source (the only source)
      expect.stringContaining("dc-repo-url-"),                                            // install-microk8s: clone URL
      expect.stringContaining('cd "$GITOPS_DIR" && sudo -n ./setup.sh --prod --tailnet-mint-join-key s1.example.com'), // install-microk8s: the create-only mint, asked again at the point of use
      expect.stringContaining(`cd "$GITOPS_DIR" && sudo -n ./setup.sh --prod --slave-add s1.example.com --slave-creds /tmp/dc-slave-creds-${runId}.json --slave-secrets "$HOME/slave-work/s1.example.com/base/secrets/secrets.prod"`), // create-mgmt
      "sudo -n microk8s kubectl -n argocd get application s1-apps -o jsonpath={.status.sync.status}", // gitops-handoff
      expect.stringContaining("-n s1 get externalsecrets.external-secrets.io"),       // verify-slave: HARD gate 0
      expect.stringContaining("-n s1 get applications.argoproj.io"),                  // verify-slave: HARD gate 1
      expect.stringContaining("dc-prom-check-"),                                          // verify-slave: soft prom
    ]);
    // Green path: the credentials were Ready on the first probe — no force-sync kick, no
    // diagnostic bundle (both fire only while a HARD gate is failing).
    expect(hosts.log.some((l) => l.command.includes("annotate externalsecrets"))).toBe(false);
    expect(hosts.log.some((l) => l.command.includes("dc-slave-diag-"))).toBe(false);

    // The Vault-sourced PAT travels ONLY via the putFile'd GIT_ASKPASS helper — never argv.
    const askpass = hosts.files.find((x) => x.host === "10.1.1.11" && x.path === `/tmp/dc-askpass-${runId}`);
    expect(askpass?.content).toContain(VAULT_PAT);
    expect(hosts.log.map((l) => l.command).join("\n")).not.toContain(VAULT_PAT);
    // The Vault auto-source ran exactly once (it is the ONLY source — no override exists).
    expect(hosts.log.filter((l) => l.command.includes("dc-fetch-repo-pat-") && !l.command.startsWith("rm -f"))).toHaveLength(1);
    // The creds blob reached the MASTER via putFile (the non-logging path), 0600 per-run file.
    const credsFile = hosts.files.find((x) => x.host === "m1.example.com" && x.path === `/tmp/dc-slave-creds-${runId}.json`);
    expect(credsFile?.content).toContain(EMIT_ARGOCD_TOKEN);
    expect(credsFile?.content).toContain(EMIT_REVIEWER_TOKEN);

    // The slave's map is written FROM MASTER in prepare-branch, from bytes the Controller composed
    // — install.sh is not invoked at all, because it knows one role and it is not this one.
    const prepare = hosts.files.find((x) => x.host === "m1.example.com" && x.path.includes("dc-prepare-branch-"))?.content ?? "";
    // set-domain.sh cuts and prunes the branch; the map carries the dial address and the values
    // the slave inherits; install.sh is SOURCED for scaffold_inputs and never run as a command.
    for (const want of ["git checkout -B master origin/master", './set-domain.sh "prod" "s1.example.com" slave',
      "apiHost: 100.64.0.11", "catalog-repo: acme/acme-catalog",
      'MASTER_CFG="$GITOPS_DIR/base/configs/config.prod"', "source ./install.sh"]) expect(prepare).toContain(want);
    expect(prepare.split("\n").filter((l) => /^\s*\.\/install\.sh\b/.test(l))).toEqual([]);
    expect(platformRepo.commits).toEqual([]);
    // The short name is DERIVED from the fqdn, so the map install.sh left carries no name of its own.
    const map = platformRepo.read(platformRepo.booksBranch, "clusters/active/s1.example.com.yaml");
    expect(map).not.toContain("name:");

    // prepare-branch checkpointed the scaffolded secrets PATH only (never contents).
    const cp2 = JSON.parse(stepColumn(db, runId, "prepare-branch", "checkpoint_json") ?? "{}") as { data?: { secretsPath?: string; branch?: string } };
    expect(cp2.data?.secretsPath).toBe("/home/m1/slave-work/s1.example.com/base/secrets/secrets.prod");
    expect(cp2.data?.branch).toBe(PARAMS.domain);
    // Step 4's checkpoint holds only IDs + the (non-secret) API server URL — never tokens.
    const cp4 = JSON.parse(stepColumn(db, runId, "create-mgmt", "checkpoint_json") ?? "{}") as {
      data?: { slaveId?: number; server?: string; clusterBearerCredId?: string; reviewerJwtCredId?: string };
    };
    expect(cp4.data?.slaveId).toBe(1);
    expect(cp4.data?.server).toBe("https://100.64.0.11:16443");
    expect(cp4.data?.clusterBearerCredId).toBe(bearer[0]?.id);
    expect(cp4.data?.reviewerJwtCredId).toBe(reviewer[0]?.id);
    // Step 5's checkpoint records the map it read back off master + the endpoint it carries.
    const cp5 = JSON.parse(stepColumn(db, runId, "gitops-handoff", "checkpoint_json") ?? "{}") as { data?: Record<string, unknown> };
    expect(cp5.data).toEqual({ markingPath: "clusters/active/s1.example.com.yaml", apiHost: "100.64.0.11", apiPort: 16443 });
    // Step 6's checkpoint: the verified surface (2 credentials, 2 apps, 2 stores, metrics +
    // cert soft-ok).
    const cp6 = JSON.parse(stepColumn(db, runId, "verify-slave", "checkpoint_json") ?? "{}") as { data?: Record<string, unknown> };
    expect(cp6.data).toEqual({ extSecrets: 2, apps: 2, secretStores: 2, prom: "data", certsTotal: 1, certsReady: 1 });
    // Step 7's checkpoint names the registered cluster + plane version.
    const cp7 = JSON.parse(stepColumn(db, runId, "register", "checkpoint_json") ?? "{}") as { data?: Record<string, unknown> };
    expect(cp7.data).toEqual({ clusterId: cluster?.id, slaveId: 1, planeV: 0 });
    // The run log announces the per-slave management surface: a per-slave
    // argo ingress (OIDC login — the local admin is now disabled), the ONE shared Headlamp on the master
    // (the slave is a cluster-picker context, not a per-slave kube), and the master's per-slave
    // Vault KV mount, which is where a slave's secrets stay — Vault is central on the master.
    const events = JSON.stringify(readEvents(db.db, runId));
    expect(events).toContain("argo → https://argo-s1.m1.example.com (ArgoCD; OIDC login via Authentik)");
    expect(events).toContain('kube → https://kube.m1.example.com (shared Headlamp; pick the \\"s1\\" cluster)');
    expect(events).toContain("KV mount s1 on https://vault.m1.example.com");
  });

  it("approves with NO secret: the PAT auto-sources from the platform Vault on the master (zero-entry approval)", async () => {
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId); // no run secret at all — the Vault is the default source
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    // The fetch ran exactly once, on the MASTER (the plan-gated aux session — the same host
    // --slave-add later reads the very same key from).
    const fetches = hosts.log.filter((l) => l.command.includes("dc-fetch-repo-pat-") && !l.command.startsWith("rm -f"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.host).toBe("m1.example.com");
    // The fetch script carries the canonical read (root token from vault-<stage>.txt, stdin
    // into vault-0, the exact platform path) — and was delivered to the master, not the slave.
    const fetchScript = hosts.files.find((x) => x.path.includes("dc-fetch-repo-pat-"));
    expect(fetchScript?.host).toBe("m1.example.com");
    expect(fetchScript?.content).toContain("vault kv get -field=repo-pat secret/prod/system/argocd");
    expect(fetchScript?.content).toContain("vault-prod.txt");
    // The auto-sourced PAT travels ONLY via the 0700 askpass helper — never argv.
    const askpass = hosts.files.find((x) => x.host === "10.1.1.11" && x.path === `/tmp/dc-askpass-${runId}`);
    expect(askpass?.content).toContain(VAULT_PAT);
    expect(hosts.log.map((l) => l.command).join("\n")).not.toContain(VAULT_PAT);
    // The run log names the SOURCE, never the value...
    const events = JSON.stringify(readEvents(db.db, runId));
    expect(events).toContain("auto-sourced from the platform Vault (GITOPS_REPO_PAT)");
    // ...and the PAT appears NOWHERE in the persisted run surface (the REDACTION test's
    // whole-db idiom: every table except the sealed credential store).
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'credentials'")
      .all() as { name: string }[];
    let dump = events;
    for (const t of tables) dump += JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${t.name}`).all());
    expect(dump).not.toContain(VAULT_PAT);
  });

  it("REDACTION: the emit-creds tokens, the Vault-sourced repo PAT and the tailnet join key appear NOWHERE in the persisted run surface", async () => {
    const { db, executor, store, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    // Sanity: the run really handled the blob (delivered to the master via putFile) and
    // really used the Vault-sourced PAT (delivered to the slave via the askpass helper).
    expect(hosts.files.some((x) => x.content.includes(EMIT_REVIEWER_TOKEN))).toBe(true);
    expect(hosts.files.some((x) => x.content.includes(VAULT_PAT))).toBe(true);
    expect(hosts.files.some((x) => x.content.includes(MINT_AUTHKEY))).toBe(true);

    // Negative assertion (adopt.test's idiom, widened to the WHOLE database): dump every
    // table except `credentials` — the credential store is the ONE sanctioned holder of the
    // sealed tokens (and even there they are sealed blobs, not raw text). planeJson carries
    // credential IDs plus the NON-secret kube-access facts (API server URL + public CA
    // bundle); it never holds a bearer token, so a succeeded run keeps the invariant.
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'credentials'")
      .all() as { name: string }[];
    let dump = JSON.stringify(readEvents(db.db, runId));
    for (const t of tables) dump += JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${t.name}`).all());
    expect(dump).not.toContain(EMIT_ARGOCD_TOKEN);
    expect(dump).not.toContain(EMIT_REVIEWER_TOKEN);
    expect(dump).not.toContain(VAULT_PAT);
    // The join key is the same class: it puts a machine of the holder's choosing on the
    // private network, and unlike the two tokens it is never sealed here — the master's Vault
    // holds it. So the run surface is the only place it could leak, and it does not.
    expect(dump).not.toContain(MINT_AUTHKEY);
    // The tokens ARE retrievable from the sealed store (they were captured, not dropped).
    const bearer = await store.list({ serverId: SLAVE_ID, kind: "kubeconfig" });
    expect(bearer).toHaveLength(1);
  });

  it("mint-join-key precedes the bring-up it serves, and the key travels by file — never argv, never a checkpoint", async () => {
    // The ordering this step exists for: the master has to be able to produce the credential
    // BEFORE the ~25-minute install that uses it, and --slave-add (which registers an
    // already-installed slave) is two steps too late to mint it.
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);

    const planned = (await executor.plan("deploy-slave", { ...PARAMS, slaveId: 2 })).plan.steps.map((s) => s.name);
    expect(planned.indexOf("mint-join-key")).toBeGreaterThanOrEqual(0);
    expect(planned.indexOf("mint-join-key")).toBeLessThan(planned.indexOf("install-microk8s"));

    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // Asked TWICE, always on the MASTER — the host that owns both the coordinator and the
    // Vault slot. Once by mint-join-key (does the master have a credential to give?) and once
    // by install-microk8s at the moment it joins. The installer's mint is create-only, so the
    // second answer is the first key, not a second live one.
    const mints = hosts.log.filter((l) => l.command.includes("--tailnet-mint-join-key"));
    expect(mints).toHaveLength(2);
    expect(mints.map((l) => l.host)).toEqual(["m1.example.com", "m1.example.com"]);

    // The key reached the SLAVE as a per-run file and nothing else: not in any command line
    // (argv is ps-visible), not in the run log.
    const staged = hosts.files.find((x) => x.host === "10.1.1.11" && x.path === `/tmp/dc-tailnet-authkey-${runId}`);
    expect(staged?.content.trim()).toBe(MINT_AUTHKEY);
    expect(hosts.log.map((l) => l.command).join(" ")).not.toContain(MINT_AUTHKEY);
    expect(JSON.stringify(readEvents(db.db, runId))).not.toContain(MINT_AUTHKEY);
    // ...and it is removed again once the join has consumed it.
    expect(hosts.log.some((l) => l.host === "10.1.1.11" && l.command === `rm -f /tmp/dc-tailnet-authkey-${runId}`)).toBe(true);
  });

  it("a retry after a failed join re-fetches and re-stages the key — the run is not stranded", async () => {
    // The property that decides whether a failed join is recoverable at all. The staged key is
    // deleted the moment the join is over, and a retry resumes at the FIRST FAILED step:
    // mint-join-key is already ok, so the executor never re-runs it. A step that inherited its
    // credential from an earlier one would therefore find nothing and fail identically forever.
    const hosts = scriptedHosts({ tailnetJoinExit: 1 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "install-microk8s")?.status).toBe("failed");

    // Whatever made the join fail is fixed (the coordinator answers, DNS resolves) and the
    // operator presses Retry — no step named, so it resumes at install-microk8s.
    hosts.tailnetJoinExit = 0;
    const beforeLog = hosts.log.length;
    const beforeFiles = hosts.files.length;
    await executor.retryFromStep(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.find((s) => s.name === "mint-join-key")?.status).toBe("ok");
    const tail = hosts.log.slice(beforeLog);
    // mint-join-key did NOT run again; install-microk8s got the credential on its own and
    // wrote it out fresh.
    expect(tail.some((l) => l.command.includes("dc-refresh-checkout-"))).toBe(false);
    expect(tail.some((l) => l.command.includes("--tailnet-mint-join-key"))).toBe(true);
    const restaged = hosts.files.slice(beforeFiles).find((x) => x.path === `/tmp/dc-tailnet-authkey-${runId}`);
    expect(restaged?.content.trim()).toBe(MINT_AUTHKEY);
  });

  it("installerPhase probe-skip: base install skipped, but the checkout is STILL refreshed (before the emit)", async () => {
    // The stale-checkout guard: a box that already carries MicroK8s + ~/hostyour-cloud must
    // NOT run --emit-mgmt-credentials (or any later setup.sh) from old code — the clone-or-
    // hard-refresh is unconditional now; only the ~25-min setup.sh stays probe-skippable.
    const hosts = scriptedHosts({ microk8sProbeExit: 0 });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId); // no override — the refresh auto-sources the PAT from the Vault
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.find((s) => s.name === "install-microk8s")?.status).toBe("ok");
    const all = hosts.log.map((l) => l.command);
    expect(all.some((c) => c.endsWith("./setup.sh --prod"))).toBe(false); // the base install NOT run
    // The refresh legs ALL ran despite the probe-skip: PAT fetch + clone URL (master),
    // askpass delivery + clone-or-refresh (slave).
    expect(all.some((c) => c.includes("dc-fetch-repo-pat-"))).toBe(true);
    expect(all.some((c) => c.includes("dc-repo-url-"))).toBe(true);
    expect(all.some((c) => c.includes("dc-clone-slave-"))).toBe(true);
    expect(hosts.files.some((x) => x.path.includes("dc-askpass-"))).toBe(true);
    expect(JSON.stringify(readEvents(db.db, runId))).toContain("already complete (probe)");
    expect(stepColumn(db, runId, "install-microk8s", "checkpoint_json")).toContain('"done"');
    // Ordering on the slave: refresh BEFORE the probe, and (critically) BEFORE step 4's
    // emit reads the checkout.
    const slaveCmds = hosts.log.filter((l) => l.host === "10.1.1.11").map((l) => l.command);
    const at = (needle: string): number => slaveCmds.findIndex((c) => c.includes(needle));
    expect(at("dc-clone-slave-")).toBeGreaterThanOrEqual(0);
    expect(at("dc-clone-slave-")).toBeLessThan(at("microk8s status --wait-ready"));
    expect(at("dc-clone-slave-")).toBeLessThan(at("--emit-mgmt-credentials"));
    // The join is NOT probe-skippable: the probe means "MicroK8s is ready", which is true of
    // every box brought up before the tailnet existed — those are exactly the hosts that would
    // otherwise stay silently off the network.
    expect(at("--tailnet-join ")).toBeGreaterThanOrEqual(0);
    // ...and the run still proceeded into step 4 (the harvest ran).
    expect(all.some((c) => c.includes("--emit-mgmt-credentials"))).toBe(true);
  });

  it("create-mgmt refreshes the MASTER's live checkout to origin/<masterFqdn> BEFORE --slave-add (the stale-master guard)", async () => {
    // The master-side twin of the slave's clone-or-hard-refresh: --slave-add runs out of the
    // master's LIVE ~/hostyour-cloud, which nothing else keeps current — the live incident was a
    // 13-commits-stale master checkout without the --slave-add flag at all. The refresh must
    // target the master's OWN install branch (branch == FQDN) and strictly precede the
    // --slave-add exec.
    const { db, executor, hosts } = await makeHarness();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // The delivered script pins the exact branch: fetch, then checkout -B onto
    // origin/<masterFqdn> (heals wrong-branch AND stale checkouts deterministically).
    const script = hosts.files.find((x) => x.host === "m1.example.com" && x.path.includes("dc-refresh-checkout-"));
    expect(script?.content).toContain('git -C "$GITOPS_DIR" fetch origin');
    expect(script?.content).toContain('checkout -B "m1.example.com" "origin/m1.example.com"');
    // ...and ran on the MASTER strictly before the --slave-add setup.sh call.
    const masterCmds = hosts.log
      .filter((l) => l.host === "m1.example.com" && !l.command.startsWith("rm -f"))
      .map((l) => l.command);
    const at = (needle: string): number => masterCmds.findIndex((c) => c.includes(needle));
    expect(at("dc-refresh-checkout-")).toBeGreaterThanOrEqual(0);
    expect(at("--slave-add")).toBeGreaterThan(at("dc-refresh-checkout-"));
    // The run record shows the refresh (before/after short HEADs — never secrets).
    expect(JSON.stringify(readEvents(db.db, runId))).toContain("master ~/hostyour-cloud refreshed aaa1111..bbb2222 on m1.example.com");
  });

  it("without a tailnet address the dial address falls back to lanHost — and BOTH sources take that one", async () => {
    // The fallback chain is tailnetHost -> lanHost -> host, resolved ONCE. What this proves is
    // that the two independent sources move together: whatever the chain yields is what the
    // cluster map's apiHost carries AND what the slave composes its own credentials blob on.
    // A row with no tailnet address is the ordinary state of a slave that sits in the master's
    // own network, and of every slave before it has ever joined.
    // The slave echoes the address it was given, which is what the real emit does; the seeded map
    // stands in for the one install.sh wrote from that same address in prepare-branch.
    const emitOut = JSON.stringify({ server: "https://10.1.1.11:16443", caData: "TFMtQ0EtREFUQQ==", argocdToken: EMIT_ARGOCD_TOKEN, reviewerToken: EMIT_REVIEWER_TOKEN });
    const hosts = scriptedHosts({ emitOut });
    const { db, executor } = await makeHarness({ hosts, marking: SLAVE_MARKING_YAML.replace("100.64.0.11", "10.1.1.11") });
    db.db.update(servers).set({ tailnetHost: null }).where(eq(servers.id, SLAVE_ID)).run();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    const emitCmd = hosts.log.find((l) => l.command.includes("--emit-mgmt-credentials"))?.command ?? "";
    expect(emitCmd).toContain("--emit-mgmt-credentials --api-host 10.1.1.11");
    const prepare = String(hosts.files.find((f) => f.content.includes("./set-domain.sh"))?.content ?? "");
    // The map the run composed carries the SAME address the emit was told to use — one address,
    // two consumers, which is the whole subject of this case.
    expect(prepare).toContain("apiHost: 10.1.1.11");
  });

  it("gitops-handoff refuses a map on master that carries no slave part — never waits on a plane that cannot generate", async () => {
    // install.sh reported success but its master push did not land the address the master's
    // in-cluster components dial (a stale origin, a rejected push). Waiting ten minutes for an
    // Application the generator can never produce would bury the real cause; the step names the
    // file instead.
    const hosts = scriptedHosts();
    const identityOnly = ["fqdn: s1.example.com", "stage: prod", "role: slave", "build-plane: m1.example.com", ""].join("\n");
    const { db, executor } = await makeHarness({ hosts, marking: identityOnly });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "gitops-handoff")?.status).toBe("failed");
    expect(JSON.stringify(readEvents(db.db, runId))).toContain("carries no apiHost/apiPort");
    // ...and it never started polling for the Application.
    expect(hosts.log.some((l) => l.command.includes("get application s1-apps"))).toBe(false);
  });

  it("the three cleanups are persisted, resolvable by name, and run in reverse order on abort-with-cleanup", async () => {
    // Park the run failed at verify-slave (the app never converges) with all three cleanups
    // registered, then abort-with-cleanup — the ONLY path that executes them.
    const hosts = scriptedHosts({ argoAppsOut: "root-applications|OutOfSync|Progressing" });
    const { db, executor, platformRepo } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    vi.useFakeTimers();
    try {
      await executor.approve(runId);
      await drainToVerifyDeadline();
    } finally {
      vi.useRealTimers();
    }
    await executor.settle(runId); // failed at verify-slave

    // Each arming step persisted exactly its own cleanup name (__cleanups)...
    for (const [step, name] of [
      ["install-microk8s", "microk8s-reset-slave"],
      ["mint-join-key", "disable-vault-mounts"],
      ["prepare-branch", "remove-slave-marking"],
    ] as const) {
      const cp = JSON.parse(stepColumn(db, runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
      expect(cp.__cleanups, step).toEqual([name]);
    }
    // ...and every persisted name resolves against def.cleanups() (abortWithCleanup's path).
    const def = buildRegistry({ db: db.db }).get("deploy-slave") as AnyRunDefinition;
    const byName = new Map((def.cleanups?.({ ...PARAMS, tier: "rehearsal" }) ?? []).map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(["disable-vault-mounts", "microk8s-reset-slave", "remove-slave-marking"]);

    const before = hosts.log.length;
    await executor.abortWithCleanup(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("cancelled");
    const cleanupSteps = run?.steps.filter((s) => s.name.startsWith("cleanup:")) ?? [];
    expect(cleanupSteps.map((s) => s.name)).toEqual([
      "cleanup:microk8s-reset-slave", "cleanup:disable-vault-mounts", "cleanup:remove-slave-marking",
    ]); // reverse registration order — the map is armed FIRST (prepare-branch), so it is dropped LAST
    expect(cleanupSteps.every((s) => s.status === "ok")).toBe(true);

    // The map cleanup drops ONLY the slave part — the cluster keeps its role, stage and build plane,
    // and it goes over the platform repo, so the master sees no shell for it at all.
    const map = platformRepo.read(platformRepo.booksBranch, "clusters/active/s1.example.com.yaml");
    expect(map).toContain("role: slave");
    expect(map).toContain("build-plane: m1.example.com");
    for (const gone of ["master:", "apiHost:", "apiPort:"]) expect(map).not.toContain(gone);

    const tail = hosts.log.slice(before);
    const at = (needle: string): number => tail.findIndex((l) => l.command.includes(needle));
    expect(at("snap remove --purge microk8s")).toBeGreaterThanOrEqual(0);
    expect(at("--slave-remove s1")).toBeGreaterThan(at("snap remove --purge microk8s"));
    // hosts: the vault leg on the MASTER, the destructive reset on the SLAVE
    expect(tail.find((l) => l.command.includes("--slave-remove s1"))?.host).toBe("m1.example.com");
    expect(tail.find((l) => l.command.includes("snap remove --purge microk8s"))?.host).toBe("10.1.1.11");
  });

  it("a second run RESUMES the parked cluster row — same slaveId, no duplicate creds, then completes", async () => {
    const hosts = scriptedHosts();
    // No cluster map at all ⇒ run 1 dies at gitops-handoff with steps 0-4 green: the run refuses to
    // invent a marking for a cluster install.sh never marked.
    const { db, executor, store, platformRepo } = await makeHarness({ hosts, keystore: "keyfile", marking: false });
    const r1 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r1.runId);
    await executor.settle(r1.runId);
    expect(getRun(db.db, r1.runId)?.status).toBe("failed");
    expect(JSON.stringify(readEvents(db.db, r1.runId))).toContain("no cluster map");

    // The map lands (the operator re-ran install.sh) — a FRESH run resumes the parked row
    platformRepo.seed(platformRepo.booksBranch, "clusters/active/s1.example.com.yaml", SLAVE_MARKING_YAML);
    const r2 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r2.runId);
    await executor.settle(r2.runId);
    expect(getRun(db.db, r2.runId)?.status).toBe("succeeded");

    const rows = db.db.select().from(clusters).all();
    expect(rows).toHaveLength(1); // resumed, not re-inserted
    expect(rows[0]?.slaveId).toBe(1); // ordinal kept
    expect(rows[0]?.status).toBe("active"); // run 2 went all the way to register
    // the recorded machine-id VERIFIES on the second run
    const events = JSON.stringify(readEvents(db.db, r2.runId));
    expect(events).toContain("machine-id verified");
    expect(events).toContain("resuming cluster");
    // step 4's sealTokenOnce reused the identical tokens instead of piling up duplicates
    expect(await store.list({ serverId: SLAVE_ID, kind: "kubeconfig" })).toHaveLength(1);
    expect(await store.list({ serverId: SLAVE_ID, kind: "other" })).toHaveLength(1);
    expect(events).toContain("already sealed");
  });

  it("redeploy is its own verb: deploy-slave refuses a LIVE cluster and names it; redeploy re-reconciles in place", async () => {
    // keyfile keystore opens the crypto gate — needed for a SECOND+ plan against a live slave, so
    // r2 reaches the attest step and exercises the cluster-state refusal, not the plaintext crypto one.
    const { db, executor } = await makeHarness({ keystore: "keyfile" });
    // Run 1 → the full green path: cluster active, server healthy.
    const r1 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r1.runId);
    await executor.settle(r1.runId);
    expect(getRun(db.db, r1.runId)?.status).toBe("succeeded");
    expect(db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get()?.status).toBe("active");

    // A PLAIN deploy on the now-live slave is refused at attest — there is no longer a parameter that
    // could talk it into proceeding — and the message names the verb that does this job. It touches
    // nothing: the refusal fires before the DNS probe, the machine-id attest and the allocation.
    const r2 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r2.runId);
    await executor.settle(r2.runId);
    expect(getRun(db.db, r2.runId)?.status).toBe("failed");
    expect(stepColumn(db, r2.runId, "attest-target", "error")).toMatch(/is the redeploy verb/);
    expect(db.db.select().from(clusters).all()).toHaveLength(1);
    expect(db.db.select().from(clusters).get()?.status).toBe("active");

    // The redeploy VERB names only the server: it reads the FQDN and the stage off the active cluster
    // row itself. The run completes and the row STAYS active + single + same slaveId (re-reconciled in
    // place, never re-inserted, never demoted).
    const r3 = await executor.plan("redeploy", { serverId: PARAMS.serverId });
    await executor.approve(r3.runId);
    await executor.settle(r3.runId);
    expect(getRun(db.db, r3.runId)?.status).toBe("succeeded");
    const rows = db.db.select().from(clusters).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slaveId).toBe(1);
    expect(rows[0]?.status).toBe("active");
    expect(JSON.stringify(readEvents(db.db, r3.runId))).toContain("re-reconciling LIVE slave");

    // ...and it armed NOT ONE compensating action. Every one of them undoes a working slave, so a
    // redeploy that fails must leave an abort with nothing to run.
    for (const step of ["prepare-branch", "install-microk8s", "create-mgmt"] as const) {
      const cp = JSON.parse(stepColumn(db, r3.runId, step, "checkpoint_json") ?? "{}") as { __cleanups?: string[] };
      expect(cp.__cleanups, step).toBeUndefined();
    }
  });

  it("redeploy refuses a server whose cluster is not live — that state is deploy-slave's to finish", async () => {
    const { db, executor } = await makeHarness({ keystore: "keyfile" });
    // No cluster row at all: nothing has a machine layer to rebuild yet.
    const err = await executor.plan("redeploy", { serverId: PARAMS.serverId }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/carries no cluster/);
    expect(db.db.select().from(clusters).all()).toHaveLength(0);
  });

  it("hard-fails attest-target when the box behind the address is NOT the machine we adopted", async () => {
    const hosts = scriptedHosts();
    // No cluster map ⇒ run 1 parks mid-journey at gitops-handoff (cluster stays planned).
    const { db, executor, platformRepo } = await makeHarness({ hosts, keystore: "keyfile", marking: false });
    const r1 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r1.runId);
    await executor.settle(r1.runId);

    hosts.machineId = "ffffffffffffffffffffffffffffffff"; // a stranger VM grabbed the IP
    platformRepo.seed(platformRepo.booksBranch, "clusters/active/s1.example.com.yaml", SLAVE_MARKING_YAML);
    const r2 = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(r2.runId);
    await executor.settle(r2.runId);

    const run2 = getRun(db.db, r2.runId);
    expect(run2?.status).toBe("failed");
    expect(run2?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");
    expect(stepColumn(db, r2.runId, "attest-target", "error")).toMatch(/not the machine we adopted/);
    // nothing moved: the row is still parked planned with its slaveId, the server stays ready
    const cluster = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get();
    expect(cluster?.status).toBe("planned");
    expect(cluster?.slaveId).toBe(1);
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("ready");
  });
});
