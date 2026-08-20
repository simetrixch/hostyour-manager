import { z } from "zod";
import { PLATFORM_CHECKOUT } from "./place-ansiwise.ts";

// The REMOTE surface of the deploy-slave Run: the few shell scripts and kubectl commands the
// steps still ship to the two hosts, plus the contracts they parse back. Everything that BUILDS
// the slave is a deployment PROGRAM of the machine's own catalogue (digita-deploy
// ansiwise/programs/) driven over `ansiwise serve` — what stands here is only what the manager
// does around those programs: git checkout upkeep, the credentials-file handover, and the
// verify/handoff kubectl reads. Pure string builders + zod contracts, no IO, no db: the def
// composes them, tests golden them.

/** The MicroK8s kube-apiserver port — a platform constant (the emit-cluster-credentials answer
 *  and the cluster map's apiPort carry the same value). */
export const SLAVE_API_PORT = 16443;

// The wildcard-DNS probe (attest-target, HARD). We only require the name to RESOLVE — to
// ANYTHING. Behind NAT (the slaves) the wildcard record points at the SHARED PUBLIC INGRESS
// IP, not the slave's own public IP, so the resolved address must NEVER be compared against
// the slave's observed public_ip (that comparison would hard-fail every NAT slave). Runs on
// the slave so it also proves the slave's own resolver sees the record (cert-manager and the
// in-cluster ACME solver resolve from there). Prefers public DNS (1.1.1.1) when dig exists.
export function dnsProbeScript(domain: string): string {
  return `#!/usr/bin/env bash
probe="dc-wildcard-probe.${domain}"
ip=""
if command -v dig >/dev/null 2>&1; then
  ip=$(dig +short A "$probe" @1.1.1.1 2>/dev/null | tail -1)
fi
if [ -z "$ip" ]; then
  ip=$(getent ahostsv4 "$probe" 2>/dev/null | awk '{print $1; exit}')
fi
if [ -n "$ip" ]; then echo "DNS_WILDCARD $ip"; else echo "DNS_WILDCARD none"; fi
`;
}

/** WHERE the master writes a SLAVE's branch — deploy-slave-branch cuts it here and
 *  regenerate-slave-branch merges the release tag into it here: a second checkout with the same
 *  origin, stood on the branch the program demands by the caller (the product branch for a cut, the
 *  slave's own branch for a regeneration). Working in the LIVE checkout would yank the machine's
 *  tree off the branch its reconciler and its installer stand on. Both programs name the path on
 *  their own rows; this constant is the caller's half of the same contract. */
export const WORK_CHECKOUT = "/srv/hostyour-cloud-slave";

// The refresh for the PLATFORM checkout at /srv/hostyour-cloud — the tree the deployment programs
// act on and deliberately never fetch into themselves (a program acts on the tree it was pointed
// at; which state that tree stands on is the caller's to establish). `fetch --tags` because a
// release needs two refs the local clone does not have yet: the pin commit the manager pushed onto
// the install branch, and the release tag it minted on the trunk. Idempotent fetch + reset --hard +
// checkout -B; `checkout -B` also HEALS a wrong-branch checkout (name AND content), not just a
// stale one. stdout contract: one `CHECKOUT_HEAD <old> <new>` line (short HEADs — secret-free).
export function refreshPlatformCheckoutScript(branch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ -d "${PLATFORM_CHECKOUT}/.git" ] || { echo "no platform checkout at ${PLATFORM_CHECKOUT} — the place-ansiwise step clones it there before any program runs, so a machine reaching this step without one lost it afterwards" >&2; exit 3; }
old=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
git -C "${PLATFORM_CHECKOUT}" fetch origin --tags
git -C "${PLATFORM_CHECKOUT}" reset --hard
git -C "${PLATFORM_CHECKOUT}" checkout -B "${branch}" "origin/${branch}"
new=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
echo "CHECKOUT_HEAD $old $new"
`;
}

// prepare-checkouts (the step before deploy-slave-branch), run over the MASTER's session — the two
// git states that program reads and refuses to establish itself:
//
//   1. the LIVE checkout on the head of the master's own install branch. The program copies the
//      master's cluster map out of the COMMITTED state of the branch the live checkout stands on
//      (its <branch> slot), so a stale checkout hands every slave an old map — the recorded live
//      incident's shape.
//   2. the WORK checkout at /srv/hostyour-cloud-slave STANDING on the product branch. The program's
//      git_branch row refuses a checkout standing anywhere else rather than moving it, which is
//      also what keeps it from ever cutting in the live checkout by mistake — so the caller stands
//      it there, cloned from the live checkout's own origin when it does not exist yet. A leftover
//      local branch of the slave's name is deleted so the cut regenerates rather than resumes onto
//      a snapshot of an older trunk.
//
// stdout contract: `LIVE_HEAD <short>` + `WORK_HEAD <short>` (secret-free).
export function masterCheckoutsScript(o: { masterFqdn: string; slaveFqdn: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ -d "${PLATFORM_CHECKOUT}/.git" ] || { echo "no platform checkout at ${PLATFORM_CHECKOUT} on the master — the machine's installation puts it there" >&2; exit 3; }
git -C "${PLATFORM_CHECKOUT}" fetch origin
git -C "${PLATFORM_CHECKOUT}" reset --hard
git -C "${PLATFORM_CHECKOUT}" checkout -B "${o.masterFqdn}" "origin/${o.masterFqdn}"
echo "LIVE_HEAD $(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)"
if [ ! -d "${WORK_CHECKOUT}/.git" ]; then
  origin=$(git -C "${PLATFORM_CHECKOUT}" remote get-url origin)
  git clone "$origin" "${WORK_CHECKOUT}"
fi
git -C "${WORK_CHECKOUT}" fetch origin
git -C "${WORK_CHECKOUT}" reset --hard
git -C "${WORK_CHECKOUT}" checkout -B master origin/master
git -C "${WORK_CHECKOUT}" clean -fd
git -C "${WORK_CHECKOUT}" branch -D "${o.slaveFqdn}" >/dev/null 2>&1 || true
echo "WORK_HEAD $(git -C "${WORK_CHECKOUT}" rev-parse --short HEAD)"
`;
}

// prepare-regeneration (the step before regenerate-slave-branch), run over the MASTER's session —
// the same two checkouts as the cut above, stood on what a REGENERATION reads instead of what a cut
// reads, and it is a separate script because all three differences would otherwise be a mode flag:
//
//   1. `fetch --tags`, on BOTH checkouts — one flag standing on two different needs. The WORK
//      checkout is the one that merges: the program's git_merge_ref row names
//      /srv/hostyour-cloud-slave and takes refs/tags/<tag>, which the release minted on the trunk
//      moments ago, so without the tag that row has nothing to merge. The LIVE checkout merges
//      nothing — what it needs is the pin COMMIT on the books branch, which a plain `fetch origin`
//      already delivers, exactly as masterCheckoutsScript above fetches that same tree. The cut
//      needs no tag at all.
//   2. the LIVE checkout on the head of the master's own install branch, which is the books branch:
//      it carries the SLAVE's cluster map, where the pin the manager just committed stands, and
//      the master's own map, which the program copies for the installation-wide values.
//   3. the WORK checkout STANDING on the SLAVE's branch, not on the product branch. The program's
//      git_merge_ref row refuses a checkout standing on any other branch rather than moving it, and
//      the branch already exists — this is a cluster that was cut once and is being brought forward.
//      No local branch is deleted here: `checkout -B` off origin/<slave> heals a stale or wrong
//      local branch (name AND content), and deleting one would throw away nothing a merge needs.
//
// stdout contract: `LIVE_HEAD <short>` + `WORK_HEAD <short>` (secret-free) — the cut's own contract,
// because both steps assert the same two facts.
export function masterRegenerationCheckoutsScript(o: { masterFqdn: string; slaveFqdn: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ -d "${PLATFORM_CHECKOUT}/.git" ] || { echo "no platform checkout at ${PLATFORM_CHECKOUT} on the master — the machine's installation puts it there" >&2; exit 3; }
git -C "${PLATFORM_CHECKOUT}" fetch origin --tags
git -C "${PLATFORM_CHECKOUT}" reset --hard
git -C "${PLATFORM_CHECKOUT}" checkout -B "${o.masterFqdn}" "origin/${o.masterFqdn}"
echo "LIVE_HEAD $(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)"
if [ ! -d "${WORK_CHECKOUT}/.git" ]; then
  origin=$(git -C "${PLATFORM_CHECKOUT}" remote get-url origin)
  git clone "$origin" "${WORK_CHECKOUT}"
fi
git -C "${WORK_CHECKOUT}" fetch origin --tags
git -C "${WORK_CHECKOUT}" reset --hard
git -C "${WORK_CHECKOUT}" checkout -B "${o.slaveFqdn}" "origin/${o.slaveFqdn}"
git -C "${WORK_CHECKOUT}" clean -fd
echo "WORK_HEAD $(git -C "${WORK_CHECKOUT}" rev-parse --short HEAD)"
`;
}

/** WHERE emit-cluster-credentials leaves the ONE cross-cluster credential handover on the slave —
 *  the program's own file_path contract: mode 0600, owned by the operating account. The caller
 *  reads it over the session it already holds, carries the values to register-slave as answers,
 *  and removes the file — never through output, because a run's record keeps output and the
 *  registration token is cluster-admin. */
export const CLUSTER_CREDENTIALS_PATH = "/tmp/ansiwise-cluster-credentials";

/** The credentials file's shape (emit-cluster-credentials' export_cluster_credentials step):
 *  the stated API address under `server`, the cluster authority, and the two BEARER tokens
 *  (cluster-admin / auth-delegator on the slave) — a leaked file is RCE across the clusters,
 *  hence the handling rules in create-mgmt. */
export const MgmtCredsBlob = z.object({
  server: z.string().startsWith("https://"),
  caData: z.string().min(1),
  argocdToken: z.string().min(16),
  reviewerToken: z.string().min(16),
});

// ============================== the verify-slave remote surface ============================

/** Every Application in the slave's ArgoCD namespace generated, one `name|sync|health` row
 *  per line (step 6 HARD gate 1). Runs on the MASTER — the slave-ArgoCD Application CRs live
 *  in namespace <name> there. */
export function argoAppsCmd(name: string): string {
  return `sudo -n microk8s kubectl -n ${name} get applications.argoproj.io -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.sync.status}{"|"}{.status.health.status}{"\\n"}{end}'`;
}

/** Every ExternalSecret in the slave's ArgoCD namespace ON THE MASTER, one
 *  `name|<Ready status>|<reason>` row per line (step 6 HARD gate 0). These materialize the
 *  instance's TWO credentials from the master's Vault (apps/slave/templates/externalsecret-*):
 *  `repo-hostyour-cloud` (the PRIVATE-repo credential — without it every root-applications
 *  comparison fails as Unknown/Unknown) and `cluster-slave` (the remote cluster
 *  registration). Gate 0 makes a stuck/failing ESO delivery a NAMED failure instead of the
 *  opaque root-applications Unknown timeout the first live run produced. */
export function externalSecretsCmd(name: string): string {
  return `sudo -n microk8s kubectl -n ${name} get externalsecrets.external-secrets.io -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.status.conditions[?(@.type=="Ready")].reason}{"\\n"}{end}'`;
}

/** Kick every ExternalSecret in ns <name> out of ESO's exponential error backoff: an annotation
 *  change forces an IMMEDIATE re-reconcile. Every ExternalSecret on this platform carries
 *  refreshInterval "0" (no periodic Vault read at all — hostyour-cloud
 *  charts/external-secret/templates/externalsecret.yaml), so a transient early failure otherwise
 *  parks the next retry MINUTES away (controller-runtime doubles per failure up to ~16 min) — the
 *  leading suspect for the recorded 14-minute Unknown/Unknown stall.
 *  This is a BACKOFF kick, not part of replacing a value: it acts on an ExternalSecret that has never synced
 *  successfully, where the reconcile has to fetch. On one that already holds a value the annotation
 *  is not what re-reads Vault — deleting the target Secret is. Harmless when healthy. */
export function forceSyncExternalSecretsCmd(name: string): string {
  return `sudo -n microk8s kubectl -n ${name} annotate externalsecrets.external-secrets.io --all force-sync=$(date +%s) --overwrite`;
}

// The step-6 diagnostic bundle (master side, ns <name>) — run while a HARD gate is failing
// (rate-limited) and once right before it throws, so the run log always carries the ACTUAL
// reason a converge window expired (the first live run died as a bare `OutOfSync/Missing`
// timeout with none of this). SECRET-FREE by construction: names, labels, conditions,
// messages and pod phases only — never secret data (`get secrets --show-labels` prints no
// values). Every section tolerates absent resources (the `|| true` idiom): diagnostics must
// never fail the step themselves.
export function slaveDiagScript(name: string): string {
  const k = `sudo -n microk8s kubectl -n ${name}`;
  return `#!/usr/bin/env bash
echo "==== verify-slave diagnostics (ns ${name}) ===="
echo "-- root-applications: sync | health | revision"
${k} get application.argoproj.io root-applications -o jsonpath='{.status.sync.status}{" | "}{.status.health.status}{" | "}{.status.sync.revision}{"\\n"}' 2>&1 || true
echo "-- root-applications: conditions (type: message)"
${k} get application.argoproj.io root-applications -o jsonpath='{range .status.conditions[*]}{.type}{": "}{.message}{"\\n"}{end}' 2>&1 || true
echo "-- root-applications: last operation (phase | message)"
${k} get application.argoproj.io root-applications -o jsonpath='{.status.operationState.phase}{" | "}{.status.operationState.message}{"\\n"}' 2>&1 || true
echo "-- externalsecrets: name | Ready | message"
${k} get externalsecrets.external-secrets.io -o jsonpath='{range .items[*]}{.metadata.name}{" | "}{.status.conditions[?(@.type=="Ready")].status}{" | "}{.status.conditions[?(@.type=="Ready")].message}{"\\n"}{end}' 2>&1 || true
echo "-- secretstores: name | Ready | message"
${k} get secretstores.external-secrets.io -o jsonpath='{range .items[*]}{.metadata.name}{" | "}{.status.conditions[?(@.type=="Ready")].status}{" | "}{.status.conditions[?(@.type=="Ready")].message}{"\\n"}{end}' 2>&1 || true
echo "-- argocd credential secrets (the repository/cluster labels MUST both appear)"
${k} get secrets -l argocd.argoproj.io/secret-type --show-labels --no-headers 2>&1 || true
echo "-- appprojects (root-applications references 'default' — created by the instance's argocd-server on boot)"
${k} get appprojects.argoproj.io -o name 2>&1 || true
echo "-- instance pods (controller/repo-server/redis must be Running for any comparison to succeed)"
${k} get pods --no-headers 2>&1 || true
echo "==== end diagnostics ===="
`;
}

/** Every ESO SecretStore ON THE SLAVE, `ns/name|<Ready status>` per line (step 6 HARD gate 2).
 *  A Ready SecretStore proves the whole per-slave Vault handshake end to end: ESO reached
 *  https://vault.<master>:8200, the kubernetes-<name> auth mount TokenReview'd the slave SA,
 *  the <name>-eso policy let it in. A missing policy binding is the classic failure here, and this
 *  surfaces it directly rather than as an opaque app failure later. Runs over the slave session — the run's ownsHost target. */
export const SECRET_STORES_CMD = `sudo -n microk8s kubectl get secretstores.external-secrets.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'`;

/** Every cert-manager Certificate on the slave, same row shape (step 6 SOFT — LE issuance
 *  can lag on DNS propagation / rate limits; a pending cert is a note, not a failure). */
export const CERTS_CMD = `sudo -n microk8s kubectl get certificates.cert-manager.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'`;

// The SOFT observability probe (step 6, master): is the slave's obs-agent pushing? Queries
// the master's IN-CLUSTER Prometheus via promtool inside the prometheus container — no
// ingress/port-forward assumption (the metrics API is deliberately not exposed on the host).
// Best-effort BY DESIGN: any miss (no pod, no promtool, no data yet) prints a marker the
// step downgrades to a meta note — the HARD gates already prove the management plane;
// push-metric freshness at deploy time is an observability nicety, so step 6 treats it as
// best-effort.
export function promCheckScript(domain: string): string {
  return `#!/usr/bin/env bash
pod=$(sudo -n microk8s kubectl -n observability get pod -l app.kubernetes.io/name=prometheus -o name 2>/dev/null | head -1)
if [ -z "$pod" ]; then echo "PROM_CHECK skipped"; exit 0; fi
res=$(sudo -n microk8s kubectl -n observability exec "$pod" -c prometheus -- promtool query instant http://localhost:9090 'up{cluster="${domain}"}' 2>/dev/null || true)
if [ -n "$res" ]; then echo "PROM_CHECK data"; else echo "PROM_CHECK empty"; fi
`;
}

/** Parse `a|b|c` rows out of a kubectl jsonpath range dump, dropping blank lines. */
export function parsePipeRows(out: string): string[][] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split("|"));
}
