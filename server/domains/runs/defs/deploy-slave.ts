import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Step, RunDefinition } from "../../../executor/types.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { STAGE, CLUSTER_TIER } from "../../../../shared/enums.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { remoteCmd, remoteExec, remoteScript, remoteScriptCapture, installerPhase, localTx } from "../../../executor/stepkit.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import { registerSecret } from "../../../security/redact.ts";
import { PREFLIGHT_SCRIPT, parsePreflightOutput, makeCheck, hardenPreflightForSlave, podCidrOverlapCheck, formatNicsLine } from "../preflight.ts";
import { recordTailnetReading } from "../tailnet-probe.ts";
import { hasHardFailure, type PreflightReport } from "../../../../shared/preflight.ts";
import {
  APP_SYNC_TIMEOUT_MS, APP_SYNC_POLL_MS, fetchRepoPatFromMasterVault,
  loadServer, loadMaster, masterFqdnOf, slaveApiHost, requireSlaveCluster, credLabels, sealTokenOnce, sleepUnlessAborted,
  microk8sResetSlaveCleanup, disableVaultMountsCleanup, removeSlaveMarkingCleanup, requirePlatformRepo, statedTarget,
  mintTailnetJoinKey,
  type DeploySlavePorts, type SlaveInstallInput,
} from "./deploy-slave.kit.ts";
import {
  prepareBranchScript, microk8sProbeCmd, MgmtCredsBlob, RESOLVE_REPO_DIR, SLAVE_API_PORT,
  REPO_URL_SCRIPT, askpassFile, cloneSlaveScript, refreshCheckoutScript, tailnetKeyPath,
} from "./deploy-slave.remote.ts";
import {
  clusterShortName, clusterMarkingPath, resolveClusterMarking, projectClusterMarking, serializeMarking,
  type ClusterMarking,
} from "../../inventory/cluster-marking.ts";
import { attestTargetStep } from "./deploy-slave.attest.ts";
import { verifySlaveStep, registerStep } from "./deploy-slave.verify.ts";

// "deploy-slave" — the Run that turns a READY (adopted) server into a live slave
//. 9 steps over TWO hosts: the slave (base MicroK8s
// install, and joining the private network) and the master (slave install branch, the join
// credential, per-slave namespace/vault + a GitOps handoff).
// mutating: true ⇒ the attest-target law (guards.ts assertGuardsArmed) requires
// steps()[0].name === "attest-target", and slaveCryptoGate restricts a
// plaintext-keystore install to the single rehearsal slave.
//
// The remote scripts live in deploy-slave.remote.ts, the shared step-kit in
// deploy-slave.kit.ts, verify-slave + register in deploy-slave.verify.ts (the file-size doctrine,
// files ≤400 lines).

export const DeploySlaveParams = z.object({
  serverId: z.string().startsWith("srv_"),
  stage: z.enum(STAGE),
  /** The slave's FQDN == its install branch == clusters.domain (one branch per slave). */
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "must be a lowercase FQDN"),
  /** Defaults to rehearsal so the parsed params satisfy slaveCryptoGate's literal check
   *  (a `real` slave is refused until the keystore hardening lifts the gate). */
  tier: z.enum(CLUSTER_TIER).default("rehearsal"),
  /** Explicit ordinal — used by a retry after a failed run (it is never recycled) or to adopt
   *  a manually provisioned slave. Omitted ⇒ attest-target allocates max(slave_id)+1. */
  slaveId: z.number().int().positive().optional(),
});
export type DeploySlaveParams = z.infer<typeof DeploySlaveParams>;

export type { DeploySlavePorts };

/** The install step list BOTH cluster verbs run: deploy-slave takes a READY server through it, and
 *  redeploy re-runs the identical, idempotent steps against a slave that is already live. `mode` is
 *  the only difference between the two, and it decides exactly one thing per step — whether the
 *  compensating action that would UNDO that step is armed (see SlaveInstallMode). */
export function deploySlaveSteps(input: SlaveInstallInput, ports: DeploySlavePorts): Step[] {
  const { target, mode } = input;
  const sid = target.serverId;
  const redeploying = mode === "redeploy";
  return [
    attestTargetStep(input),
    {
      name: "slave-preflight",
      title: "Preflight the slave (hard policy)",
      run: async (ctx) => {
        // The adopt checks re-run under the SLAVE-HARD policy (an adoptable box may still be
        // un-deployable): every severity becomes hard, and bound 80/443 / missing snapd —
        // warnings at adopt time — are promoted to failures (preflight.ts SLAVE_FAIL_ON_WARN).
        const server = loadServer(ctx.db, sid);
        const master = loadMaster(ctx.db);
        const masterFqdn = masterFqdnOf(ctx.db, master);
        const session = await ctx.ssh();
        const cap = await remoteScriptCapture(ctx, session, "slave-preflight", PREFLIGHT_SCRIPT, { timeoutMs: 60_000 });
        const parsed = parsePreflightOutput(cap.stdout);
        ctx.log("meta", formatNicsLine(parsed));
        const checks = hardenPreflightForSlave(parsed.checks);

        // Slave extra: the master's Vault must answer FROM THE SLAVE (the per-slave KV mount
        // lives there; slave-ESO authenticates against it). Reached over the Traefik
        // INGRESS (https://vault.<master>, :443) — the master's Vault is a ClusterIP with no
        // host-port/nodeport, so :8200 is unreachable off-cluster; only the ingress (/v1/**
        // IngressRoute) is externally reachable. curl WITHOUT -f on purpose: /v1/sys/health
        // answers 429/472/473/501/503 for standby/uninitialized/sealed — ANY http code proves
        // reachability; only a transport failure fails.
        const url = `https://vault.${masterFqdn}/v1/sys/health`;
        let httpCode = "";
        const vr = await session.exec(`curl -4 -sS -o /dev/null --max-time 10 -w '%{http_code}' ${url}`, {
          signal: ctx.signal,
          onStdout: (l) => {
            httpCode += l.trim();
            ctx.log("stdout", l);
          },
          onStderr: (l) => ctx.log("stderr", l),
        });
        const reachable = vr.code === 0 && /^[1-5]\d\d$/.test(httpCode);
        checks.push(makeCheck("vault.reachable", reachable ? "pass" : "fail",
          reachable ? `HTTP ${httpCode} from ${url}` : `no HTTP answer from ${url} (curl exit ${vr.code}${httpCode ? `, code ${httpCode}` : ""})`));

        // The pod (Calico) CIDR must be disjoint from the cluster LAN, or controller pods can't
        // route to the slave's LAN IP (the `dial …:16443 i/o timeout` blocker). Purely LOCAL — the
        // Controller already knows the cluster LAN (the /24 around the inventory lanHost) and the
        // installer's default pod CIDR; no probe. Reads `lanHost` and NOT the address the slave is
        // dialled on: this asks about the cluster network, and a slave dialled on its tailnet
        // address is out of a pod pool's reach by construction. Skipped (no check pushed) when
        // lanHost is unknown/not an IPv4 — a NAT/FQDN row yields no cluster LAN.
        const overlap = podCidrOverlapCheck(server.lanHost);
        if (overlap) checks.push(overlap);
        else ctx.log("meta", `pod-CIDR/cluster-LAN overlap check skipped — server ${server.name} has no IPv4 lanHost to derive the cluster LAN from`);

        const report: PreflightReport = { checkedAt: Date.now(), checks };
        // Merge under its own key — never clobber the adopt report (hostKey pins ctx.ssh!).
        const pf = (server.preflightJson as Record<string, unknown> | null) ?? {};
        localTx(ctx, (tx) => tx.update(servers).set({ preflightJson: { ...pf, slavePreflight: report } }).where(eq(servers.id, sid)).run());
        ctx.checkpoint({ checkCount: checks.length });

        if (hasHardFailure(report)) {
          const failed = report.checks.filter((c) => c.severity === "hard" && c.status === "fail");
          throw errValidation(
            `Slave preflight failed: ${failed.map((c) => `${c.title} — ${c.detail}${c.hint ? ` (${c.hint})` : ""}`).join("; ")}`,
          );
        }
      },
    },
    {
      name: "prepare-branch",
      title: "Prepare the cluster map on master + the slave install branch",
      run: async (ctx) => {
        const { domain, stage } = target.resolve(ctx.db);
        const server = loadServer(ctx.db, sid);
        const master = loadMaster(ctx.db);
        const masterFqdn = masterFqdnOf(ctx.db, master);
        // Cross-step state lives in the DB, not in checkpoints: attest-target's tx put the
        // allocated ordinal on the cluster row.
        const cluster = ctx.db.select().from(clusters).where(eq(clusters.domain, domain)).get();
        if (!cluster || cluster.slaveId === null) throw errValidation(`no provisioning cluster row for ${domain} — attest-target must run first`);
        // The slave inherits the installation's own values from the MASTER's map: where it pulls
        // images from, the public apex its units serve under, the business domain, where alerts go,
        // and the catalog repository. Read BEFORE the cleanup is armed and before any shell reaches
        // the master, so a map missing something fails here, naming the file, with nothing to undo.
        //
        // catalog-repo is the one that must be present: set-role.sh runs on the slave's own branch
        // and dies outright without it, so a slave installed past this point would fail at step
        // 3/4 with the branch already pushed.
        const masterMarking = await resolveClusterMarking(requirePlatformRepo(ports), masterFqdn);
        if (masterMarking.catalogRepo === undefined) {
          throw errValidation(
            `${clusterMarkingPath(masterFqdn)} on ${requirePlatformRepo(ports).booksBranch} carries no catalog-repo — ` +
            `set-role.sh refuses to run without it, so the slave's branch would be cut and pushed only to fail there; ` +
            `add catalog-repo: <owner>/<name> to the master's map, then retry the run`,
          );
        }
        // The slave's map, composed by the ONE writer of that file. The same bytes go onto the
        // slave's own branch (prepare-branch, below — set-role.sh reads them there) and onto the
        // books branch (commitMarking, where the slaves ApplicationSet generator reads them).
        const slaveMarking: ClusterMarking = {
          fqdn: domain,
          // Derived, never read back from the file — the same rule the module states for every map.
          name: clusterShortName(domain),
          stage,
          role: "slave",
          // A slave pulls its images from wherever its master does. `buildPlane` is the derived
          // "is that me?", which for a slave whose build plane is its master is false — and true in
          // the one case the master IS the build plane and this slave shares its machine under a
          // second fqdn, where the two fqdns are still different names.
          buildPlane: masterMarking.buildPlaneFqdn === domain,
          buildPlaneFqdn: masterMarking.buildPlaneFqdn,
          master: masterFqdn,
          apiHost: slaveApiHost(server),
          apiPort: SLAVE_API_PORT,
          ...(masterMarking.unitApex !== undefined ? { unitApex: masterMarking.unitApex } : {}),
          ...(masterMarking.platformDomain !== undefined ? { platformDomain: masterMarking.platformDomain } : {}),
          ...(masterMarking.alertRecipients !== undefined ? { alertRecipients: masterMarking.alertRecipients } : {}),
          catalogRepo: masterMarking.catalogRepo,
        };
        // Armed BEFORE the script, because THIS step is where the cluster map lands on master —
        // install.sh writes it there before it branches off master. Dropping the slave part again
        // is the inverse: it takes the cluster out of the master's slaves ApplicationSet, whose
        // finalizer then cascades the teardown of the management plane. NEVER armed on a
        // redeploy — that cascade against a LIVE slave is exactly what must not happen.
        if (!redeploying) ctx.registerCleanup(removeSlaveMarkingCleanup(ports));
        const session = await ctx.ssh(master.id); // the AUX target — declared in `targets`, so the plan gate allows it
        const cap = await remoteScriptCapture(
          ctx, session, "prepare-branch",
          prepareBranchScript({ stage, slaveFqdn: domain, mapYaml: serializeMarking(slaveMarking) }),
          { timeoutMs: 10 * 60_000 },
        );
        if (cap.result.code !== 0) throw errValidation(`prepare-branch failed on the master (exit ${cap.result.code}) — see the run log`);
        const secretsPath = /^SECRETS_PATH (.+)$/m.exec(cap.stdout)?.[1]?.trim();
        if (!secretsPath) throw errValidation("prepare-branch did not report the scaffolded secrets path (SECRETS_PATH line missing)");
        // Checkpoint ONLY the PATH of the scaffolded secrets file — step 4 (create-mgmt) seeds
        // the per-slave vault from it ON the master; its CONTENTS never leave the master.
        ctx.checkpoint({ branch: domain, secretsPath });
        ctx.log("meta", `slave branch ${domain} prepared on the master; scaffolded secrets at ${secretsPath}`);
      },
    },
    {
      name: "mint-join-key",
      title: "Mint the slave's tailnet join credential on the master",
      run: async (ctx) => {
        const { domain, stage } = target.resolve(ctx.db);
        const master = loadMaster(ctx.db);
        // Registered before the FIRST master-side per-slave state exists — the coordinator user
        // and the Vault slot this step creates are both undone by --slave-remove, which is what
        // this cleanup runs (it tolerates absent state, so early registration is safe). Without
        // it here, an abort between here and create-mgmt would leave a live join credential for
        // a slave that was never built. NEVER armed on a redeploy: --slave-remove takes a LIVE
        // slave off the tailnet and destroys its seeded secrets.
        if (!redeploying) ctx.registerCleanup(disableVaultMountsCleanup);

        // ---- 0. Refresh the master's LIVE ~/hostyour-cloud checkout to its own install-branch
        // head. This is the FIRST step that runs setup.sh out of that checkout, and every
        // later master leg (--slave-add) runs out of the same tree — the live incident was a
        // 13-commits-stale checkout that did not carry the flag being passed to it, which
        // fails as an unknown option rather than as anything readable. Branch == the master's
        // FQDN (masterFqdnOf — the same derivation the git-branch lock uses, so the refresh
        // runs under that lock); gitignored base/secrets/* survive the reset by construction.
        // Placed here rather than later so a broken master checkout costs nothing: it fails
        // before the slave's ~25-minute base install instead of after it.
        const masterFqdn = masterFqdnOf(ctx.db, master);
        const mSession = await ctx.ssh(master.id);
        const refresh = await remoteScriptCapture(ctx, mSession, "refresh-checkout",
          refreshCheckoutScript(masterFqdn), { timeoutMs: 2 * 60_000 });
        const heads = /^CHECKOUT_HEAD (\S+) (\S+)$/m.exec(refresh.stdout);
        if (refresh.result.code !== 0 || !heads) {
          throw errValidation(
            `could not refresh the master's ~/hostyour-cloud checkout to origin/${masterFqdn} on ${master.host} (exit ${refresh.result.code}) — ` +
            `every master-side setup.sh action must run from the CURRENT install-branch head, never a stale tree; see the run log ` +
            `(is ~/hostyour-cloud a git checkout tracking origin's ${masterFqdn} branch?), fix the master's checkout, then retry the run`,
          );
        }
        ctx.log("meta", `master ~/hostyour-cloud refreshed ${heads[1]}..${heads[2]} on ${masterFqdn}`);

        // ---- 1. Mint, and check the master can produce a usable credential AT ALL — that the
        // coordinator answers, that its Vault slot is writable, and that this installer knows
        // the flag. The returned key is deliberately DROPPED here: install-microk8s asks for it
        // again at the moment it joins, and gets the same one back (the installer's mint is
        // create-only). Carrying it across the step boundary is what would make that step
        // un-retryable, and there is no other channel for it — a value like this may not become
        // a checkpoint.
        //
        // So what this step buys is the moment of failure. A master that cannot mint costs
        // seconds here instead of surfacing after the slave's ~25-minute base install.
        await mintTailnetJoinKey(ctx, mSession, { stage, domain });
        ctx.log("meta", `the master can mint ${domain}'s join credential — install-microk8s asks for it again at the moment it joins`);
      },
    },
    {
      name: "install-microk8s",
      title: "Install MicroK8s on the slave (base install)",
      run: async (ctx) => {
        // Registered FIRST (before anything mutates): a setup.sh that dies halfway leaves a
        // half-provisioned snap only the reset can compensate. Destructive — executed only
        // by an explicit abort-with-cleanup, never automatically. NEVER armed on a
        // redeploy: `snap remove --purge microk8s` on a LIVE production node is catastrophic,
        // and the undo is only meaningful for a fresh planned/provisioning install (a live
        // re-reconcile that fails is left intact — the row stays active/healthy anyway).
        if (!redeploying) ctx.registerCleanup(microk8sResetSlaveCleanup);
        const { domain, stage } = target.resolve(ctx.db);
        const master = loadMaster(ctx.db);
        const session = await ctx.ssh(); // the slave (the run's ownsHost target)

        // ---- 1. Clone OR hard-refresh the slave branch onto the slave (cloneSlaveScript
        // handles both) — UNCONDITIONALLY, i.e. OUTSIDE the probe-gated phase below. It used
        // to live inside the phase's `run`, where the probe-skip (MicroK8s ready + clone
        // present ⇒ skip) silently skipped the refresh too: a box already carrying MicroK8s
        // plus a STALE ~/hostyour-cloud checkout (e.g. a pre-rename tree from an earlier
        // iteration) then ran --emit-mgmt-credentials (step 4) and every later setup.sh call
        // from OLD code. The refresh is cheap (fetch + reset to the exact remote head); only
        // the ~25-min base install stays probe-skippable. Ordering: this completes before the
        // phase AND before step 4's emit reads the checkout.
        //    Needs the PAT (private repo, for clone AND fetch): ALWAYS auto-sourced from the
        //    platform Vault on the master (GITOPS_REPO_PAT — the exact key --slave-add copies
        //    into the slave's own consumable). Unconditional — the Vault is the single
        //    source; approval collects nothing and there is no manual override.
        const mSession = await ctx.ssh(master.id);
        const pat = await fetchRepoPatFromMasterVault(ctx, mSession, stage);
        ctx.log("meta", "repo PAT: auto-sourced from the platform Vault (GITOPS_REPO_PAT) — held in memory for this run only");
        // Clone URL from the MASTER's live checkout, sanitized THERE (see REPO_URL_SCRIPT)
        // and re-validated HERE: nothing carrying userinfo may reach the (logged) git cmd.
        const urlCap = await remoteScriptCapture(ctx, mSession, "repo-url", REPO_URL_SCRIPT, { timeoutMs: 30_000 });
        const repoUrl = /^REPO_URL (\S+)$/m.exec(urlCap.stdout)?.[1];
        if (urlCap.result.code !== 0 || !repoUrl || !/^https:\/\/[^@\s]+$/.test(repoUrl)) {
          throw errValidation("could not derive a credential-free https clone URL from the master's checkout");
        }
        // The PAT rides ONLY inside the 0700 GIT_ASKPASS helper (putFile — a non-logging
        // path; never argv, never .git/config), removed right after.
        const askpassPath = `/tmp/dc-askpass-${ctx.runId}`;
        await session.putFile(askpassPath, Buffer.from(askpassFile(pat.toString("utf8")), "utf8"), 0o700, { signal: ctx.signal });
        try {
          const r = await remoteScript(ctx, session, "clone-slave", cloneSlaveScript({ domain, repoUrl, askpassPath }), { timeoutMs: 5 * 60_000 });
          if (r.code !== 0) throw errValidation(`git clone/refresh of the slave branch ${domain} failed (exit ${r.code}) — is the Vault-sourced repo PAT (GITOPS_REPO_PAT) a valid read-only PAT for the repo?`);
        } finally {
          try {
            await session.exec(`rm -f ${askpassPath}`, { signal: ctx.signal });
          } catch {
            // best-effort — the helper is 0700 and user-owned
          }
        }

        // ---- 2. The base install, probe-skippable as before (a ready MicroK8s + the clone
        // just guaranteed above ⇒ skip the ~25-min run; setup.sh re-runs converge anyway).
        await installerPhase(ctx, session, "install-microk8s", {
          probe: async (c, s) => (await remoteExec(c, s, microk8sProbeCmd())).code === 0,
          run: async (c, s, opts) => {
            // The ENTIRE slave-side imperative surface: MicroK8s + addons + storage +
            // cert-manager/ClusterIssuer. Streamed; opts carries installerPhase's generous
            // wall clock (DEFAULT_PHASE_TIMEOUT_MS, ~25-min run).
            await remoteCmd(c, s, `${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage}`, opts);
          },
          verify: async (c, s) => {
            await remoteCmd(c, s, "sudo -n microk8s kubectl wait --for=condition=Ready node --all --timeout=180s", { timeoutMs: 240_000 });
            // ANY ClusterIssuer present — its NAME is config-owned (CLUSTER_ISSUER_NAME).
            await remoteCmd(c, s, "sudo -n microk8s kubectl get clusterissuers.cert-manager.io -o name | grep -q .");
          },
        });

        // ---- 3. Join the private network. The credential is fetched HERE, at the point of use,
        // and the whole of its life on the slave is this try/finally: fetched, written 0600,
        // consumed, deleted — whichever way the join ends. Anything earlier would leave a live
        // single-use key on a box for the rest of its 24h whenever a step above throws, and
        // would make a retry of THIS step impossible, since the executor never re-runs the step
        // that produced it. The mint is create-only, so asking again yields the key
        // mint-join-key already made rather than a second one.
        //   OUTSIDE the probe-gated phase for the same reason the clone above is: the
        // probe-skip means "MicroK8s is ready", which is true of every box brought up before
        // this existed — folding it into the skippable phase would leave exactly those hosts
        // silently off the network, and the next thing to notice would be the master's ArgoCD
        // unable to reach the slave at all. The installer is idempotent here (a host already
        // logged in to this coordinator is left alone) and fails loudly when it cannot join.
        const keyPath = tailnetKeyPath(ctx.runId);
        try {
          // The key rides ONLY inside a 0600 file delivered over putFile (a non-logging path;
          // never argv, which is ps-visible on the host) — the installer reads it by path.
          const authkey = await mintTailnetJoinKey(ctx, mSession, { stage, domain });
          await session.putFile(keyPath, Buffer.from(`${authkey}\n`, "utf8"), 0o600, { signal: ctx.signal });
          const joined = await remoteExec(ctx, session, `${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage} --tailnet-join --tailnet-join-key-file ${keyPath}`, { timeoutMs: 5 * 60_000 });
          if (joined.code !== 0) {
            throw errValidation(
              `the slave could not join the tailnet (exit ${joined.code}) — see the run log; ` +
              `the master's ArgoCD and Vault reach a slave over that network, so a slave that is not on it cannot be managed`,
            );
          }
        } finally {
          try {
            await session.exec(`rm -f ${keyPath}`, { signal: ctx.signal });
          } catch {
            // best-effort — the file is 0600 and the key is single-use and time-boxed
          }
        }

        // ---- 4. Record what the host now says about its membership. THIS is the reading that
        // describes a managed slave: the only other one is adopt's, taken before the client was
        // even installed, so without this every deployed slave would keep saying "no client"
        // about the machine the master's ArgoCD and Vault are talking to. Read from the host
        // rather than assumed from the join's exit code — the row is meant to carry what was
        // measured, and the address and coordinator only exist on the host.
        await recordTailnetReading(ctx, session, sid);
      },
    },
    {
      name: "create-mgmt",
      title: "Create the master-side slave-management plane (vault + argocd)",
      run: async (ctx) => {
        const { domain, stage } = target.resolve(ctx.db);
        const server = loadServer(ctx.db, sid);
        const master = loadMaster(ctx.db);
        const cluster = requireSlaveCluster(ctx.db, domain);
        // The compensation for a half-configured --slave-add is --slave-remove, and it is
        // already armed: mint-join-key registered it when it made the first master-side state
        // this run owns.
        localTx(ctx, (tx) => tx.update(clusters).set({ planeState: "creating" }).where(eq(clusters.id, cluster.id)).run());

        // The master's ~/hostyour-cloud checkout was refreshed to its own install-branch head by
        // mint-join-key, the first step that runs setup.sh out of it; --slave-add below runs
        // out of the same tree, under the same git-branch lock, in the same run.
        const mSession = await ctx.ssh(master.id);

        // ---- 1. Harvest the slave management credentials (the ONE cross-cluster handshake).
        // stdout carries ONLY the JSON blob (setup.sh's fd-3 contract) and is captured
        // WITHOUT ctx.log: it holds two bearer tokens (cluster-admin + auth-delegator) — a
        // leaked blob is RCE across the clusters. Every captured byte is registered with the
        // redactor BEFORE anything can throw, so even an accidental echo elsewhere is masked.
        // stderr is the lib's log stream (secret-free by contract) and streams normally.
        //
        // --api-host: STATE the address the master's in-cluster components will dial. The slave
        // cannot work it out for itself — a joined host holds a tailnet address AND a LAN address
        // and cannot tell which one the master routes to, and a wrong pick is not a loud failure:
        // it plants an unreachable kubernetes_host in the master's Vault and only dies ~15 min
        // later in --slave-add's TokenReview smoke test. This is the SAME value prepare-branch put
        // in the cluster map's apiHost field, so the git side and this blob carry one address.
        const slave = await ctx.ssh();
        const apiHost = slaveApiHost(server);
        if (!/^[a-z0-9._:-]+$/i.test(apiHost)) {
          // The address rides this step's argv and the cluster map — refuse garbage early.
          throw errValidation(`server ${server.name} has a malformed API address "${apiHost}" — fix the inventory row (tailnetHost, lanHost or host)`);
        }
        ctx.log("meta", `running --emit-mgmt-credentials on the slave (--api-host ${apiHost})...`);
        const lines: string[] = [];
        const emit = await slave.exec(`${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage} --emit-mgmt-credentials --api-host ${apiHost}`, {
          signal: ctx.signal,
          timeoutMs: 5 * 60_000,
          onStdout: (l) => {
            lines.push(l); // NEVER ctx.log — this is the token blob
          },
          onStderr: (l) => ctx.log("stderr", l),
        });
        const raw = lines.join("\n").trim();
        if (raw.length > 0) registerSecret(ctx.runId, Buffer.from(raw, "utf8"));
        if (emit.code !== 0) throw errValidation(`--emit-mgmt-credentials failed on the slave (exit ${emit.code}) — see the run log (stderr)`);
        let blob: z.infer<typeof MgmtCredsBlob>;
        try {
          blob = MgmtCredsBlob.parse(JSON.parse(raw));
        } catch {
          // Deliberately static: the raw output must never ride an error message into steps.error.
          throw errValidation("the slave did not emit a valid management-credentials JSON blob ({server, caData, argocdToken, reviewerToken})");
        }
        registerSecret(ctx.runId, Buffer.from(blob.argocdToken, "utf8"));
        registerSecret(ctx.runId, Buffer.from(blob.reviewerToken, "utf8"));
        // The blob's server URL is the only non-secret field worth echoing (both tokens and
        // the raw blob are registered with the redactor above — never log them).
        ctx.log("meta", `management-credentials blob parsed — slave API server ${blob.server}`);

        // The blob's server URL is what the per-slave Vault targets (remote TokenReview) and what
        // the shared dashboard and this process's per-slave kube client inherit; the cluster map
        // carries the same address for the ArgoCD cluster Secret. Both were composed from the ONE
        // apiHost above, so a difference here can only mean the slave ran installer code that
        // ignored the flag (a stale checkout) — HARD-fail rather than register a kubernetes_host
        // the master may not route to and find out fifteen minutes later.
        //
        // Compared case-INSENSITIVELY on both sides. A host name is case-insensitive and the URL
        // parser lower-cases what it reads, while the inventory row keeps whatever the operator
        // typed; comparing the two raw makes `S1.example.com` fail this step with a diagnosis
        // ("its installer ignored the flag") that is the opposite of what happened.
        if (new URL(blob.server).hostname !== apiHost.toLowerCase()) {
          throw errValidation(
            `the slave reported API server ${blob.server} although --api-host ${apiHost} was passed — ` +
            `its installer ignored the flag (stale checkout?); refusing to register a kubernetes_host ` +
            `the master may not route to (the cluster map says ${apiHost})`,
          );
        }

        // ---- 2. Register the slave on the master: per-slave vault mounts + auth + policies +
        // roles + seeding + argocd consumables + the slave's OWN AppProject <name> (the
        // slaves-appset's generated Application references it, so it MUST exist before step 5
        // commits the pointer file) — all via --slave-add, idempotent end-to-end. The blob
        // reaches the master ONLY via putFile (non-logging) into a 0600 per-run temp file,
        // removed in the finally. --slave-secrets: "$HOME/slave-work/<fqdn>/..." expands ON the
        // master to exactly the path prepare-branch checkpointed — deterministic by
        // construction (a domain def must not read another step's checkpoint row: the runs
        // schema is executor-owned); --slave-add itself fails loudly if the file is missing.
        const credsPath = `/tmp/dc-slave-creds-${ctx.runId}.json`;
        await mSession.putFile(credsPath, Buffer.from(raw, "utf8"), 0o600, { signal: ctx.signal });
        ctx.log("meta", `running --slave-add ${domain} on the master...`);
        try {
          await remoteCmd(
            ctx, mSession,
            `${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage} --slave-add ${domain} --slave-creds ${credsPath} --slave-secrets "$HOME/slave-work/${domain}/base/secrets/secrets.${stage}"`,
            { timeoutMs: 15 * 60_000 },
          );
        } finally {
          try {
            await mSession.exec(`rm -f ${credsPath}`, { signal: ctx.signal });
          } catch {
            // best-effort — the file is 0600 and removed on the next run's putFile anyway
          }
        }

        // ---- 3. Seal the DURABLE creds into the credential store, tied to the slave's
        // serverId, so a later remove-/rebuild-slave finds them (ClusterPlane v0 slots
        // credentialIds.clusterBearer / reviewerJwt). The cluster bearer is
        // the cluster-ACCESS credential (kind "kubeconfig" — the closest CREDENTIAL_KIND);
        // the reviewer JWT is "other". Only the credential IDs are checkpointed; step 7
        // (register) finds them again via the same kind+label (credLabels).
        const labels = credLabels(server.name);
        ctx.log("meta", `sealing the cluster bearer credential ("${labels.bearer}")...`);
        const clusterBearerCredId = await sealTokenOnce(ctx, {
          kind: "kubeconfig", label: labels.bearer, serverId: sid, token: blob.argocdToken,
        });
        ctx.log("meta", `sealing the vault reviewer credential ("${labels.reviewer}")...`);
        const reviewerJwtCredId = await sealTokenOnce(ctx, {
          kind: "other", label: labels.reviewer, serverId: sid, token: blob.reviewerToken,
        });

        // ---- 4. Persist the slave's kube-access facts (the emit's API server URL + base64 CA
        // bundle) onto the cluster row so register folds them into ClusterPlaneV0.kube — the
        // resolver then builds a per-cluster kube client from the plane ALONE, without a
        // cross-namespace read of the master's cluster-slave Secret. caData was previously
        // DROPPED here; neither field is a secret (caData is a public CA cert), so both ride
        // planeJson unredacted. The cluster row is the sanctioned non-secret cross-step channel
        // (attest-target → prepare-branch already use it); MERGED into any existing plane so a
        // redeploy that crashes before register keeps a live slave's plane intact.
        localTx(ctx, (tx) => {
          const existingPlane = (cluster.planeJson as Record<string, unknown> | null) ?? {};
          tx.update(clusters).set({ planeJson: { ...existingPlane, kube: { server: blob.server, caData: blob.caData } } }).where(eq(clusters.id, cluster.id)).run();
        });

        ctx.checkpoint({ slaveId: cluster.slaveId, server: blob.server, clusterBearerCredId, reviewerJwtCredId });
        ctx.log("meta", `slave ${server.name} registered on the master (per-slave vault mounts + argocd consumables + AppProject ${server.name}); bearer + reviewer sealed (${clusterBearerCredId}, ${reviewerJwtCredId})`);
      },
    },
    {
      name: "gitops-handoff",
      title: "Hand off to GitOps (confirm the cluster map on master, then wait for the sync)",
      run: async (ctx) => {
        const { domain } = target.resolve(ctx.db);
        const master = loadMaster(ctx.db);
        const apiHost = slaveApiHost(loadServer(ctx.db, sid));
        // Read the map back FROM MASTER over the platform repo. install.sh pushed it there in
        // prepare-branch, and a push it could not make is the one failure that leaves everything
        // downstream reading a cluster that, as far as master is concerned, does not exist — so
        // this reads the pushed bytes rather than trusting the exit code of a shell two steps ago.
        const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
        if (marking.apiHost === undefined || marking.apiPort === undefined) {
          throw errValidation(`${clusterMarkingPath(domain)} on master carries no apiHost/apiPort — the master's slaves ApplicationSet cannot dial this slave's kube-apiserver; re-run prepare-branch`);
        }
        // Present is not enough — it has to be the SAME address create-mgmt put into Vault, the
        // shared dashboard and this process's kube client. The two sources are independent (git
        // here, the slave-composed blob there), and a map an operator repointed by hand between
        // the two steps moves only this one: the ArgoCD cluster Secret would then dial one address
        // while everything else dials the other, which surfaces as an opaque ESO/ArgoCD failure
        // with nothing pointing at the split. Case-insensitive for the reason create-mgmt is.
        if (marking.apiHost.toLowerCase() !== apiHost.toLowerCase()) {
          throw errValidation(
            `${clusterMarkingPath(domain)} on master says apiHost ${marking.apiHost}, but this run registered the slave on ${apiHost} — ` +
            `the master's ArgoCD would dial one address while its Vault, the shared dashboard and this Controller dial the other; ` +
            `put one address in both (the inventory row's tailnetHost/lanHost/host and the map), then re-run`,
          );
        }
        ctx.log("meta", `${clusterMarkingPath(domain)} on ${requirePlatformRepo(ports).booksBranch}: role ${marking.role}, stage ${marking.stage}, ${marking.apiHost}:${marking.apiPort}, build plane ${marking.buildPlaneFqdn}`);
        // The map is the authority for role and stage; the inventory rows are the copy this
        // process queries. Project them so the two cannot drift apart behind the operator's back.
        const moved = projectClusterMarking(ctx.db, marking, { actor: "op_system", runId: ctx.runId });
        if (moved.role || moved.stage) ctx.log("meta", `cluster map corrected inventory: ${JSON.stringify(moved)}`);
        ctx.checkpoint({ markingPath: clusterMarkingPath(domain), apiHost: marking.apiHost, apiPort: marking.apiPort });

        // The map's slave part IS the slave's management plane: wait — bounded, abortable —
        // until the master's ArgoCD has GENERATED (slaves-appset) and SYNCED Application
        // <name>-apps. The map landed BEFORE --slave-add created the AppProject, so the generated
        // Application legitimately waits on that missing project and syncs once it exists.
        const mSession = await ctx.ssh(master.id);
        const appName = `${clusterShortName(domain)}-apps`;
        const deadline = Date.now() + APP_SYNC_TIMEOUT_MS;
        for (;;) {
          let sync = "";
          const r = await mSession.exec(`sudo -n microk8s kubectl -n argocd get application ${appName} -o jsonpath={.status.sync.status}`, {
            signal: ctx.signal,
            timeoutMs: 30_000,
            onStdout: (l) => {
              sync += l.trim();
              ctx.log("stdout", l);
            },
            onStderr: (l) => ctx.log("stderr", l),
          });
          if (r.code === 0 && sync === "Synced") break;
          if (Date.now() >= deadline) {
            throw errValidation(`Application ${appName} did not reach Synced within ${APP_SYNC_TIMEOUT_MS / 60_000} min — check the master's ArgoCD (slaves-appset) and the pushed map ${clusterMarkingPath(domain)}`);
          }
          ctx.log("meta", `waiting for Application ${appName} to appear + sync (currently: ${sync || "absent"})`);
          await sleepUnlessAborted(APP_SYNC_POLL_MS, ctx.signal);
        }
        ctx.log("meta", `Application ${appName} is Synced — the ${clusterShortName(domain)} slave-ArgoCD now drives the slave from branch ${domain}`);
      },
    },
    // verify-slave (master+slave): HARD — the instance's ESO-materialized credentials Ready
    // in ns <name> (repo + cluster; with a force-sync kick against ESO error backoff), every
    // Application in ns <name> Synced/Healthy, every slave ESO SecretStore Ready (one bounded
    // retry window, with a rate-limited master-side diagnostic bundle while a gate fails);
    // SOFT — master Prometheus sees up{cluster="<fqdn>"}, slave ingress certs issued.
    verifySlaveStep(target),
    // register (local tx, overwrite-idempotent): cluster→active + provisionedAt + planeState
    // ready + planeJson (ClusterPlaneV0, shared/plane.ts); server→healthy; plane facts logged.
    registerStep(target),
  ];
}

/** deploy-slave's own share of the shared step list: the operator stated the FQDN and the stage, so
 *  the target lookup is a constant, and the mode arms every compensating action. */
function installInput(params: DeploySlaveParams): SlaveInstallInput {
  return {
    target: statedTarget(params.serverId, params.domain, params.stage),
    mode: "deploy",
    slaveId: params.slaveId,
    tier: params.tier,
  };
}

export function makeDeploySlaveDef(ports: DeploySlavePorts): RunDefinition<DeploySlaveParams> {
  return {
  kind: "deploy-slave",
  paramsSchema: DeploySlaveParams,
  mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted at registry boot
  plan: async (params, { db }) => {
    const slave = loadServer(db, params.serverId);
    const master = loadMaster(db);
    if (master.id === slave.id) throw errValidation("the master cannot be deployed as a slave");
    const stepDefs = deploySlaveSteps(installInput(params), ports);
    // The address the run will actually dial. Neither target below states a transport, so the slave
    // resolves the way every run always has — and the card must name the address the first connect
    // line in the log names, or an operator approves one address and gets the other.
    const dialled = resolveTransport(slave, "default");
    return {
      kind: "deploy-slave",
      targetKind: "server",
      targetId: params.serverId,
      summary:
        `Deploy "${slave.name}" (${dialled.host}) as ${params.stage} slave ${params.domain}` +
        `${params.slaveId !== undefined ? ` (slaveId ${params.slaveId})` : ""} [tier ${params.tier}]: ` +
        `${stepDefs.length} steps over two hosts — the slave (base install) and the master "${master.name}" (branch + management plane).`,
      steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
      // BOTH hosts are declared so ctx.ssh(slave) AND ctx.ssh(master) pass the plan gate;
      // only the slave is owned (server:<slave> lock derives from ownsHost).
      targets: [
        { serverId: slave.id, ownsHost: true, label: `${slave.name} (slave)` },
        { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
      ],
      // The locks beyond the derived server:<slave>: both touched git branches (the slave's
      // install branch is created + cloned; the master's branch takes the pointer commit),
      // the master's Vault surface (--slave-add mounts/policies/roles), and the master's
      // kube-apiserver (vault-0 exec + the per-slave namespace). Key "m" and no per-cluster key,
      // because the platform has ONE Vault and it sits on the master: a second deploy-slave (or any
      // other master-vault Run) therefore serializes instead of interleaving Vault surgery.
      locks: [
        { resource: "git-branch", key: params.domain },
        { resource: "git-branch", key: masterFqdnOf(db, master) },
        { resource: "master-vault", key: "m" },
        { resource: "master-kube", key: "m" },
      ],
      warnings: [
        `The read-only repo PAT is auto-sourced during the run from the platform Vault on the master (GITOPS_REPO_PAT — secret/${params.stage}/system/argocd:repo-pat); no manual entry at approval.`,
      ],
      requiredSecrets: [],
    };
  },
  steps: (params) => deploySlaveSteps(installInput(params), ports),
  // The compensating actions the install steps register (resolved by NAME from
  // the persisted __cleanups, run in reverse registration order on an explicit
  // abort-with-cleanup): microk8s-reset-slave (install-microk8s) → disable-vault-mounts
  // (mint-join-key) → remove-slave-marking (prepare-branch). Each is armed by the step that
  // made the thing it undoes, and the map is made FIRST now that install.sh writes it before it
  // branches — so the generator entry is dropped last, once the plane it points at is already
  // gone. attest-target and slave-preflight create nothing a cleanup could compensate (the
  // install branch on the remote is the operator's to keep — a retry resumes onto it);
  // verify-slave and register only verify + register, so an abort after them runs exactly the
  // three real cleanups.
  cleanups: () => [microk8sResetSlaveCleanup, disableVaultMountsCleanup, removeSlaveMarkingCleanup(ports)],
  onTerminal: (status, { db, params }) => {
    if (status === "succeeded") return; // step 7 (register) set the terminal states
    const sid = String(params.serverId);
    const domain = String(params.domain);
    // Free the server (provisioning→ready; never clobber another status) and park the
    // cluster row back at `planned` KEEPING its allocated slaveId — the ordinal is never
    // recycled (clusters_slave_id_uq); a retry resumes the row (or passes slaveId explicitly).
    db.update(servers)
      .set({ status: "ready" })
      .where(and(eq(servers.id, sid), eq(servers.status, "provisioning")))
      .run();
    db.update(clusters)
      .set({ status: "planned" })
      .where(and(eq(clusters.domain, domain), eq(clusters.status, "provisioning")))
      .run();
  },
};
}
