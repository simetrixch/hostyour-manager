import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../../executor/types.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { remoteScriptCapture, localTx } from "../../../executor/stepkit.ts";
import { ClusterPlaneV0, SlaveKubeAccess } from "../../../../shared/plane.ts";
import {
  APP_SYNC_POLL_MS, loadServer, loadMaster, masterFqdnOf, requireSlaveCluster,
  credLabels, newestCredId, sleepUnlessAborted, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import {
  argoAppsCmd, externalSecretsCmd, forceSyncExternalSecretsCmd,
  slaveDiagScript, SECRET_STORES_CMD, CERTS_CMD, promCheckScript, parsePipeRows,
} from "./deploy-slave.remote.ts";

// deploy-slave steps 6-7 (the last two steps): the
// management-plane health gate and the terminal registration. Split out of deploy-slave.ts
// (files ≤400 lines); deploy-slave.ts composes these into its step list.
//
// verify-slave's checks, HARD vs SOFT:
//   HARD 0  every ExternalSecret in ns <name> on the master reports Ready (master kubectl)
//           — the instance's repo + cluster credentials; a not-yet-Ready ES is force-sync
//           annotated (rate-limited) to break ESO's exponential error backoff, the leading
//           suspect for the first live run's 14-minute root-applications Unknown stall
//   HARD 1  every Application in ns <name> is Synced AND Healthy        (master kubectl)
//   HARD 2  every ESO SecretStore on the slave reports Ready            (slave kubectl)
//   SOFT 1  master Prometheus has an up{cluster="<fqdn>"} series        (promtool exec)
//   SOFT 2  every cert-manager Certificate on the slave is Ready        (slave kubectl)
// The HARD gates share ONE bounded retry window (cold-bootstrap races: the appset sync
// backoff maxes at 3m, then the slave-ArgoCD itself deploys and the slave pulls images); the
// SOFT checks degrade to meta notes — observability niceties must not fail a healthy plane.
// While a HARD gate is failing, the step periodically runs the step-6 diagnostic bundle
// (slaveDiagScript: root-applications conditions/operationState, ES/SecretStore Ready
// messages, credential-secret labels, appprojects, instance pods) and once more right before
// it throws — the run log then names the ACTUAL blocker instead of a bare status timeout.

/** Step 6's bounded verify window. Generous: after step 5's Synced Application, a cold
 *  slave-ArgoCD still has to deploy itself, register the slave, generate + sync the whole app
 *  tree and pull the ENTIRE platform's images on the slave — on a first-ever deploy that
 *  alone can eat 15+ minutes, and the first live run additionally burned ~14 min in an ESO
 *  backoff stall before failing at exactly the old 15-min mark. Exported for the tests (they
 *  expire it under fake timers, so the size costs them nothing). */
export const VERIFY_SLAVE_TIMEOUT_MS = 30 * 60_000;

/** How often, while a HARD gate is failing, the diagnostic bundle runs / a not-Ready
 *  ExternalSecret gets a force-sync kick. Rate-limited so the 10s poll cadence stays
 *  readable in the run log. */
export const VERIFY_DIAG_EVERY_MS = 60_000;
export const ES_KICK_EVERY_MS = 2 * 60_000;

/** One captured exec leg for the verify polls: streams to the run log (like the step-5
 *  wait) and returns the full stdout for parsing. */
async function execCapture(ctx: StepCtx, session: SshSession, command: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const r = await session.exec(command, {
    signal: ctx.signal,
    timeoutMs,
    onStdout: (l) => {
      lines.push(l);
      ctx.log("stdout", l);
    },
    onStderr: (l) => ctx.log("stderr", l),
  });
  return { code: r.code, out: lines.join("\n") };
}

/** Bounded, abortable convergence loop (step 6's retry window): the probe reports ok
 *  or a human-readable detail; an expired deadline turns the last detail into a HARD fail.
 *  The optional `diagnose` hook fires while the probe is failing — rate-limited to
 *  VERIFY_DIAG_EVERY_MS and once more right before the throw — and never fails the loop
 *  itself (diagnostics are evidence, not a gate). */
async function pollUntil(
  ctx: StepCtx, what: string, deadline: number,
  probe: () => Promise<{ ok: boolean; detail: string }>,
  diagnose?: () => Promise<void>,
): Promise<void> {
  let lastDiagAt = 0;
  const tryDiagnose = async (force: boolean): Promise<void> => {
    if (!diagnose || (!force && Date.now() - lastDiagAt < VERIFY_DIAG_EVERY_MS)) return;
    lastDiagAt = Date.now();
    try {
      await diagnose();
    } catch {
      // best-effort: a failing diagnostic leg must never mask the real converge state
    }
  };
  for (;;) {
    let r: { ok: boolean; detail: string };
    try {
      r = await probe();
    } catch (e) {
      if (!isChannelOpenFailure(e)) throw e;
      r = { ok: false, detail: `transient SSH channel refusal — ${(e as Error).message}` };
    }
    if (r.ok) return;
    if (Date.now() >= deadline) {
      await tryDiagnose(true); // the terminal evidence — always taken, right above the throw
      throw errValidation(`${what} did not converge within ${VERIFY_SLAVE_TIMEOUT_MS / 60_000} min — last state: ${r.detail}${diagnose ? " (diagnostics in the run log above)" : ""}`);
    }
    await tryDiagnose(false);
    ctx.log("meta", `waiting for ${what} (${r.detail})`);
    await sleepUnlessAborted(APP_SYNC_POLL_MS, ctx.signal);
  }
}

/** The ssh2 signature of sshd refusing ONE MORE channel on a live connection ("(SSH)
 *  Channel open failure: open failed" — OpenSSH MaxSessions pressure, the leaked-SFTP
 *  incident): the connection itself is fine and every poll leg releases its channel on
 *  close, so the NEXT cadence tick can succeed — a 30-min verify must not die on one
 *  refused open. Everything else (abort, exec failures, a dead connection) still
 *  propagates: a refusal-until-deadline surfaces this detail in the final throw. */
function isChannelOpenFailure(e: unknown): boolean {
  return e instanceof Error && e.name !== "AbortError" && /channel open failure/i.test(e.message);
}

const cell = (v: string | undefined): string => (v !== undefined && v !== "" ? v : "?");

/** Step 6 `verify-slave` (stateless, re-runnable). */
export function verifySlaveStep(target: SlaveTarget): Step {
  return {
    name: "verify-slave",
    title: "Verify the slave (credentials, apps Synced/Healthy, ESO, metrics, cert)",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const name = server.name;
      const master = loadMaster(ctx.db);
      const cluster = requireSlaveCluster(ctx.db, domain);
      localTx(ctx, (tx) => tx.update(clusters).set({ planeState: "verifying" }).where(eq(clusters.id, cluster.id)).run());
      const mSession = await ctx.ssh(master.id);
      const slave = await ctx.ssh(); // the slave (the run's ownsHost target)
      const deadline = Date.now() + VERIFY_SLAVE_TIMEOUT_MS; // ONE window for all HARD gates

      // The shared master-side diagnostic bundle (rate-limited by pollUntil): conditions,
      // operation state, ES/SecretStore messages, credential-secret labels, pods — the
      // evidence the first live run's bare `OutOfSync/Missing` timeout never surfaced.
      const diagnose = async (): Promise<void> => {
        await remoteScriptCapture(ctx, mSession, "slave-diag", slaveDiagScript(name), { timeoutMs: 60_000 });
      };

      // ---- HARD 0: EVERY ESO-materialized credential of the instance is Ready in ns <name> ON THE
      // MASTER — the repository credentials and the remote cluster registration. The gate counts
      // what it finds rather than naming them, so a credential the chart gains is gated too, and one
      // it loses does not leave this step waiting for a row nothing writes. Without the repository
      // credential the
      // instance cannot even FETCH the private repo — root-applications then sits at
      // Unknown/Unknown, which is exactly how the first live run died. A not-yet-Ready ES is
      // kicked with the chart's own force-sync annotation idiom (rate-limited): an annotation
      // change forces an immediate ESO re-reconcile, breaking the controller-runtime error
      // backoff that can otherwise park the next retry up to ~16 minutes away.
      let extSecrets = 0;
      let lastKickAt = 0;
      await pollUntil(ctx, `${name} ExternalSecrets Ready (repo + cluster credentials)`, deadline, async () => {
        const { code, out } = await execCapture(ctx, mSession, externalSecretsCmd(name), 30_000);
        if (code !== 0) return { ok: false, detail: `kubectl exit ${code} (ns ${name} not answering yet?)` };
        const rows = parsePipeRows(out);
        if (rows.length === 0) return { ok: false, detail: `no ExternalSecrets in ns ${name} yet (the ${name}-apps sync may still be applying)` };
        extSecrets = rows.length;
        const notReady = rows.filter((r) => r[1] !== "True");
        if (notReady.length === 0) return { ok: true, detail: "" };
        if (Date.now() - lastKickAt >= ES_KICK_EVERY_MS) {
          lastKickAt = Date.now();
          ctx.log("meta", `force-sync annotating the ${name} ExternalSecrets (breaks a possible ESO error backoff)`);
          await execCapture(ctx, mSession, forceSyncExternalSecretsCmd(name), 30_000);
        }
        return { ok: false, detail: `${extSecrets - notReady.length}/${extSecrets} Ready — pending: ${notReady.slice(0, 5).map((r) => `${cell(r[0])} (${cell(r[2])})`).join(", ")}` };
      }, diagnose);
      ctx.log("meta", `${name}: all ${extSecrets} ExternalSecrets Ready — the instance's repo + cluster credentials are materialized`);

      // ---- HARD 1: every Application in ns <name> is Synced AND Healthy. THE plane gate: the
      // slave-ArgoCD is up (ns <name>), reached the slave (the "<name>" cluster secret works),
      // and every app on the slave branch converged. Zero Applications = still generating ⇒ retry.
      let apps = 0;
      await pollUntil(ctx, `${name} applications Synced+Healthy`, deadline, async () => {
        const { code, out } = await execCapture(ctx, mSession, argoAppsCmd(name), 30_000);
        if (code !== 0) return { ok: false, detail: `kubectl exit ${code} (ns ${name} not answering yet?)` };
        const rows = parsePipeRows(out);
        if (rows.length === 0) return { ok: false, detail: `no Applications in ns ${name} yet (appset still generating)` };
        apps = rows.length;
        const pending = rows.filter((r) => r[1] !== "Synced" || r[2] !== "Healthy");
        if (pending.length === 0) return { ok: true, detail: "" };
        return { ok: false, detail: `${apps - pending.length}/${apps} ready — pending: ${pending.slice(0, 5).map((r) => `${cell(r[0])} (${cell(r[1])}/${cell(r[2])})`).join(", ")}` };
      }, diagnose);
      ctx.log("meta", `${name}: all ${apps} generated Applications are Synced + Healthy`);

      // ---- HARD 2: every ESO SecretStore ON THE SLAVE reports Ready — proves the whole
      // per-slave Vault handshake (mount, kubernetes-<name> TokenReview, <name>-eso policy)
      // end to end, directly on the slave (reachable: the run owns the slave session).
      let stores = 0;
      await pollUntil(ctx, "slave ESO SecretStores Ready", deadline, async () => {
        const { code, out } = await execCapture(ctx, slave, SECRET_STORES_CMD, 30_000);
        if (code !== 0) return { ok: false, detail: `kubectl exit ${code} on the slave` };
        const rows = parsePipeRows(out);
        if (rows.length === 0) return { ok: false, detail: "no SecretStores on the slave yet (external-secrets still rolling out)" };
        stores = rows.length;
        const notReady = rows.filter((r) => r[1] !== "True");
        if (notReady.length === 0) return { ok: true, detail: "" };
        return { ok: false, detail: `${stores - notReady.length}/${stores} Ready — pending: ${notReady.slice(0, 5).map((r) => cell(r[0])).join(", ")}` };
      });
      ctx.log("meta", `slave ESO: all ${stores} SecretStores are Ready — the ${name} vault auth path is proven`);

      // ---- SOFT 1: the slave's obs-agent is pushing (master Prometheus, promtool exec).
      const promCap = await remoteScriptCapture(ctx, mSession, "prom-check", promCheckScript(domain), { timeoutMs: 60_000 });
      const prom = (promCap.result.code === 0 ? /^PROM_CHECK (\S+)/m.exec(promCap.stdout)?.[1] : undefined) ?? "skipped";
      ctx.log("meta",
        prom === "data"
          ? `Prometheus sees up{cluster="${domain}"} — the slave's obs-agent is pushing`
          : prom === "empty"
            ? `soft: no up{cluster="${domain}"} series yet — the obs-agent push may still be warming up (check master Grafana)`
            : "soft: could not query the master's Prometheus — metrics check skipped (verify via Grafana)");

      // ---- SOFT 2: slave ingress certs issued (LE order/DNS can lag; a pending cert is a note).
      const certCap = await execCapture(ctx, slave, CERTS_CMD, 30_000);
      const certRows = certCap.code === 0 ? parsePipeRows(certCap.out) : [];
      const certsReady = certRows.filter((r) => r[1] === "True").length;
      ctx.log("meta",
        certCap.code !== 0
          ? "soft: could not list Certificates on the slave — cert check skipped"
          : certRows.length === 0
            ? "soft: no Certificates on the slave yet (ingresses may still be syncing)"
            : certsReady === certRows.length
              ? `slave ingress certs: ${certsReady}/${certRows.length} Ready`
              : `soft: slave ingress certs still issuing — ${certsReady}/${certRows.length} Ready; pending: ${certRows.filter((r) => r[1] !== "True").slice(0, 5).map((r) => cell(r[0])).join(", ")}`);

      ctx.checkpoint({ extSecrets, apps, secretStores: stores, prom, certsTotal: certRows.length, certsReady });
    },
  };
}

/** Step 7 `register` (local tx only, overwrite-idempotent — overwrite-idempotent because register re-runs). */
export function registerStep(target: SlaveTarget): Step {
  return {
    name: "register",
    title: "Register the cluster (active + plane v0)",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const name = server.name;
      const master = loadMaster(ctx.db);
      const masterFqdn = masterFqdnOf(ctx.db, master);
      const cluster = requireSlaveCluster(ctx.db, domain);

      // The durable credential IDs step 4 sealed — resolved from the credential store by
      // kind+label (sealTokenOnce guarantees the newest matching row IS step 4's).
      const labels = credLabels(name);
      const clusterBearer = await newestCredId(ctx, { serverId: target.serverId, kind: "kubeconfig", label: labels.bearer });
      const reviewerJwt = await newestCredId(ctx, { serverId: target.serverId, kind: "other", label: labels.reviewer });
      if (!clusterBearer || !reviewerJwt) {
        throw errValidation(`the sealed ${name} credentials are missing from the store — create-mgmt must run first`);
      }

      // The slave's kube-access facts create-mgmt stashed on the cluster row (its step 4):
      // the API server URL + the base64 CA bundle. Folded into ClusterPlaneV0.kube so the
      // resolver builds a per-cluster kube client from the plane alone (no cross-namespace
      // read of the master's cluster-slave Secret). A crash-resumed register re-reads its own
      // full plane, which already carries .kube — so this is idempotent.
      const kube = SlaveKubeAccess.safeParse((cluster.planeJson as { kube?: unknown } | null)?.kube);
      if (!kube.success) {
        throw errValidation(`the ${name} kube-access facts (API server + CA) are missing from the cluster row — create-mgmt must run first`);
      }

      // ClusterPlane v0 (shared/plane.ts): every stable fact a later Run / the
      // P4 plane detector needs to find this slave's management plane again. Validated through
      // the zod schema so a malformed plane can never reach the row. Every per-slave resource
      // is named by the slave NAME <name> (never the internal ordinal).
      const plane = ClusterPlaneV0.parse({
        v: 0,
        branch: domain, // == clusters.domain == the install branch
        slaveId: cluster.slaveId,
        vault: {
          addr: `https://vault.${masterFqdn}`, // :443 Traefik ingress — the master's Vault is a ClusterIP, unreachable off-cluster on :8200
          kvMount: name,
          k8sAuthPath: `kubernetes-${name}`,
          policy: `${name}-eso`,
        },
        argo: { namespace: name, appName: `${name}-apps` },
        kube: kube.data, // { server, caData } — the direct kube-apiserver dial facts (create-mgmt)
        credentialIds: { clusterBearer, reviewerJwt },
        hostnames: { kube: `kube-${name}.${masterFqdn}` },
      } satisfies ClusterPlaneV0);

      // Overwrite-idempotent by construction: absolute values only, and provisionedAt is
      // KEPT once set — a crash-resumed re-run converges instead of re-stamping history.
      localTx(ctx, (tx) => {
        tx.update(clusters)
          .set({ status: "active", provisionedAt: cluster.provisionedAt ?? new Date(), planeState: "ready", planeJson: plane })
          .where(eq(clusters.id, cluster.id))
          .run();
        tx.update(servers).set({ status: "healthy" }).where(eq(servers.id, target.serverId)).run();
      });
      ctx.checkpoint({ clusterId: cluster.id, slaveId: cluster.slaveId, planeV: plane.v });
      ctx.log("meta", `cluster ${cluster.id} is ACTIVE — ${domain} (slave ${name}, ${stage}) now runs from its own branch under ns ${name}`);
      // The per-slave management surface on the master: argo has its
      // own name-based Ingress under the *.<masterFqdn> wildcard, OIDC login via the master's
      // Authentik (the local admin account is OFF). The kube dashboard is NOT per-slave — it's
      // the ONE shared Headlamp on the master (kube.<masterFqdn>) where this slave shows up as a
      // cluster-picker context (Piece B). The Vault surface is the master's per-slave KV mount and
      // stays that way — Vault is central on the master, so a slave never gets its own instance:
      ctx.log("meta",
        `slave management on the master (ns ${name}): ` +
        `argo → https://argo-${name}.${masterFqdn} (ArgoCD; OIDC login via Authentik) · ` +
        `kube → https://kube.${masterFqdn} (shared Headlamp; pick the "${name}" cluster) · ` +
        `vault → KV mount ${name} on https://vault.${masterFqdn}`);
    },
  };
}
