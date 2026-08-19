import { z } from "zod";

// The REMOTE surface of the deploy-slave Run: every shell script
// and kubectl command the steps ship to the two hosts, plus the stdout contracts they parse
// back. Split out of deploy-slave.ts (files ≤400 lines) — pure string builders
// + zod contracts, no IO, no db: the def composes them, tests golden them.

/** The MicroK8s kube-apiserver port — a platform constant (the installer's slave role uses the
 *  same value; the pointer-file contract and set-role.sh share it). */
export const SLAVE_API_PORT = 16443;

// Locate the GitOps checkout on a host DYNAMICALLY — no hardcoded dir name. The repo checkout
// used to be assumed at ~/hostyour-cloud; when the repo was renamed (→ hostyour-cloud) every hardcode
// broke. Instead we DISCOVER it: the one directory under $HOME that is a git repo AND carries the
// installer (install.sh + setup.sh). Sets $GITOPS_DIR. Fails LOUDLY (exit 3) if none is found or
// if more than one matches (a stale second clone must be removed — keep exactly one checkout).
// Prepended to every script that touches the checkout; the scripts then use "$GITOPS_DIR".
export const RESOLVE_REPO_DIR = `GITOPS_DIR=""
for _d in "$HOME"/*/; do
  if [ -d "\${_d}.git" ] && [ -f "\${_d}install.sh" ] && [ -f "\${_d}setup.sh" ]; then
    if [ -n "$GITOPS_DIR" ]; then echo "ambiguous: multiple GitOps checkouts under \\$HOME ($GITOPS_DIR and \${_d%/}) — keep exactly one (remove the stale clone)" >&2; exit 3; fi
    GITOPS_DIR="\${_d%/}"
  fi
done
[ -n "$GITOPS_DIR" ] || { echo "no GitOps checkout under \\$HOME (need a directory with .git + install.sh + setup.sh) — clone the repo first" >&2; exit 3; }`;

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

// prepare-branch (step 2), run over the MASTER's session. A scratch clone under
// ~/slave-work/<fqdn> — NEVER the live checkout: set-domain.sh does `git checkout -b <fqdn>`,
// which would yank the master's working tree off its own install branch. The master's live clone
// provides the push-capable origin URL, and its own config.<stage> provides the installation's
// values (see below).
//
// NO install.sh. A slave is a separate FQDN with its own install branch and its own cluster map,
// like every other slave — and install.sh knows one role, `master`. So the three acts it used to
// perform for a slave are performed here, each by the thing that owns it:
//
//   1. set-domain.sh cuts and stamps the branch. Its `slave` arm is what PRUNES registrations/ and
//      the foreign cluster maps off it: the books live on the branch of the cluster holding the
//      master, and a second copy would go stale the moment the Controller writes to that one.
//   2. The map is written from bytes the CONTROLLER composed (serializeMarking) and injected below.
//      It lands on this branch, where set-role.sh reads it; commitMarking puts the same bytes on the
//      books branch, where the slaves ApplicationSet generator reads them. One writer, two
//      destinations — composing the file a second time in shell is how the two would drift.
//   3. scaffold_inputs fills base/secrets/<stage>. install.sh is sourceable (its main is guarded),
//      which is how hostyour-cloud's own scaffold check drives the function; sourcing gives the
//      logging framework it uses along with it.
//
// THE INSTALLATION'S VALUES ARE INHERITED, not asked. This runs on the master, so the master's live
// config.<stage> is right there and carries all six — the two mailboxes, the alert recipients, the
// unit apex, the platform domain and the build plane. Sourcing it is the supported way to read that
// file (setup.sh sources it too), and it is what makes the slave part of the SAME installation
// rather than a second one that answered the questions again. The three values that name a machine
// (DEPLOY_ENV, DOMAIN_SUFFIX, CLUSTER_NAME) come from the master's copy as well but are overwritten
// by scaffold_inputs from this slave's own fqdn and stage.
//
// The branch is REGENERATED from origin/master on EVERY run — never checked out and reused as-is.
// A pre-existing slave branch is a snapshot of an OLDER trunk, and running from it hands the
// per-slave ArgoCD a tree stamped by old code while the master-side apps/slave chart deploys the
// current shape; root-applications then syncs garbage. A slave branch is machine-generated, and
// deploy-slave only targets planned/provisioning clusters, so regeneration can never destroy live
// state. `git clean -fd` first because the previous run left config.<stage> behind — tracked on the
// install branch, untracked on master — and the gitignored base/secrets/* survives it, which is
// what makes the scaffold idempotent (step 4 reads the file via --slave-secrets).
export function prepareBranchScript(o: { stage: string; slaveFqdn: string; mapYaml: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${RESOLVE_REPO_DIR}
MASTER_CFG="$GITOPS_DIR/base/configs/config.${o.stage}"
[ -f "$MASTER_CFG" ] || { echo "no $MASTER_CFG on the master — the slave inherits this installation's values from it" >&2; exit 1; }
WORK="$HOME/slave-work/${o.slaveFqdn}"
if [ ! -d "$WORK/.git" ]; then
  origin=$(git -C "$GITOPS_DIR" remote get-url origin)
  mkdir -p "$(dirname "$WORK")"
  git clone "$origin" "$WORK"
fi
cd "$WORK"
git fetch origin
git reset --hard
git checkout -B master origin/master
git clean -fd
git branch -D "${o.slaveFqdn}" >/dev/null 2>&1 || true
./set-domain.sh "${o.stage}" "${o.slaveFqdn}" slave
mkdir -p clusters/active
cat > "clusters/active/${o.slaveFqdn}.yaml" <<'DC_MAP_EOF'
${o.mapYaml}DC_MAP_EOF
set -a
# shellcheck disable=SC1090
. "$MASTER_CFG"
set +a
STAGE="${o.stage}"
FQDN="${o.slaveFqdn}"
# shellcheck disable=SC1091
source ./install.sh
scaffold_inputs
git add -A
git -c user.name="hostyour-manager" -c user.email="controller@localhost" commit -q -m "install: ${o.stage} ${o.slaveFqdn} (slave)" || true
git push --force-with-lease origin "${o.slaveFqdn}"
SECRETS="base/secrets/secrets.${o.stage}"
test -f "$SECRETS" || { echo "missing scaffolded $SECRETS" >&2; exit 1; }
echo "SECRETS_PATH $WORK/$SECRETS"
`;
}

/** Step 3's idempotence probe for the BASE INSTALL only. Strengthens the bare `microk8s status
 *  --wait-ready` check by ALSO requiring the branch clone: steps 4-5 run setup.sh out of
 *  ~/hostyour-cloud, so "phase already complete" must mean BOTH exist. NOTE: the clone-or-hard-
 *  refresh of ~/hostyour-cloud now ALWAYS runs BEFORE this probe (deploy-slave.ts step 3) —
 *  a probe-skip therefore skips only the ~25-min setup.sh, never the checkout refresh
 *  (a stale checkout must never feed --emit-mgmt-credentials or later setup.sh calls). */
export function microk8sProbeCmd(): string {
  // Probe: a GitOps checkout must exist AND MicroK8s be ready to skip the base install. The
  // resolver exits 3 when no checkout is present (⇒ probe fails ⇒ base install runs); otherwise
  // the trailing microk8s status is the probe result.
  return `${RESOLVE_REPO_DIR}
sudo -n microk8s status --wait-ready --timeout 5 >/dev/null 2>&1`;
}

/** The --emit-mgmt-credentials stdout contract (the installer's slave-management emit +
 *  setup.sh's fd-3 redirect): ONE JSON blob and NOTHING else on stdout; every log line rides
 *  stderr. argocdToken/reviewerToken are BEARER tokens (cluster-admin / auth-delegator on the
 *  slave) — a leaked blob is RCE across the clusters, hence the handling rules in step 4. */
export const MgmtCredsBlob = z.object({
  server: z.string().startsWith("https://"),
  caData: z.string().min(1),
  argocdToken: z.string().min(16),
  reviewerToken: z.string().min(16),
});

// Derive a CREDENTIAL-FREE https clone URL from the master's live checkout (the master's
// origin is authoritative for "which repo drives the clusters" — same source prepare-branch uses).
// The master's origin may carry a push-capable PAT or be an ssh URL: both are stripped /
// mapped BEFORE anything is printed, because this stdout IS logged. The console side
// re-validates the result (refuses any userinfo) before it ever appears in a git command.
export const REPO_URL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${RESOLVE_REPO_DIR}
origin=$(git -C "$GITOPS_DIR" remote get-url origin)
clean="$origin"
case "$clean" in
  git@*:*)     rest="\${clean#git@}"; clean="https://\${rest%%:*}/\${rest#*:}" ;;
  ssh://git@*) clean="https://\${clean#ssh://git@}" ;;
  https://*@*) clean="https://\${clean#https://*@}" ;;
esac
case "$clean" in
  https://*) : ;;
  *) echo "unsupported origin URL (want https or git@/ssh)" >&2; exit 1 ;;
esac
echo "REPO_URL $clean"
`;

// Auto-source the READ-ONLY repo PAT from the PLATFORM Vault, run over the MASTER's session
// (step 3, when approval supplied no override). Replicates the installer's own canonical
// read (lib/slave.sh --slave-add step 6a — the same key it copies into the slave's
// app/<name>/repo-pat consumable): the Vault root token comes from vault-<stage>.txt at the
// one place resolve_secret_file (hostyour-cloud/base/lib/lifecycle.sh) looks, base/secrets, and
// rides ONLY stdin into vault-0 (never argv — kubectl exec args are ps-visible) — it NEVER
// leaves the master. The Controller's OWN Vault client cannot make this read: its policy
// (`controller`, seed-vault.sh) is secret/controller/cred/* only. stdout carries ONLY the
// PAT — the caller (fetchRepoPatFromMasterVault) captures it WITHOUT ctx.log and registers
// it with the redactor; every diagnostic rides stderr (secret-free by construction).
export function fetchRepoPatScript(stage: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${RESOLVE_REPO_DIR}
cd "$GITOPS_DIR"
creds="base/secrets/vault-${stage}.txt"
if ! sudo -n test -f "$creds"; then
  echo "no $creds on the master — has --deploy-vault run here?" >&2
  exit 3
fi
token=$(sudo -n grep -m1 '^Root Token:' "$creds" | awk '{print $3}') || token=""
if [ -z "$token" ]; then
  echo "no 'Root Token:' line in $creds — cannot authenticate against the platform Vault" >&2
  exit 3
fi
ns=$(grep -h '^VAULT_NAMESPACE=' "base/configs/config.${stage}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"') || ns=""
printf '%s\\n' "$token" | sudo -n microk8s kubectl -n "\${ns:-vault}" exec -i vault-0 -- sh -c '
  IFS= read -r t
  export VAULT_TOKEN="$t" VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true
  exec vault kv get -field=repo-pat secret/${stage}/system/argocd
'
`;
}

/** The --tailnet-mint-join-key stdout contract (lib/tailnet.sh + setup.sh's fd-3 redirect):
 *  ONE JSON blob and NOTHING else on stdout; every log line rides stderr. `authkey` is a
 *  pre-auth key for the private network — anything holding it can put a machine of its own on
 *  the tailnet, so it is handled exactly like the management blob: captured off ctx.log and
 *  registered with the redactor. */
export const TailnetJoinKeyBlob = z.object({
  authkey: z.string().min(16),
});

/** Where the minted key is staged on the slave for `--tailnet-join-key-file`. Keyed on the run so
 *  two runs cannot read each other's file. Derived, never remembered: the path is recomputed where
 *  it is written and where it is removed, because a domain def may not read another step's
 *  checkpoint row — and the key this path holds must never BE one. */
export function tailnetKeyPath(runId: string): string {
  return `/tmp/dc-tailnet-authkey-${runId}`;
}

/** One-shot GIT_ASKPASS helper carrying the read-only PAT (0700, deleted right after the
 *  clone). git asks "Username for ..." then "Password for ..." — answer both. The PAT is
 *  single-quoted (defensively escaped); GitHub ignores the username for PAT auth. */
export function askpassFile(pat: string): string {
  const quoted = pat.replace(/'/g, `'\\''`);
  return `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) printf '%s\\n' '${quoted}' ;;
esac
`;
}

// Clone the slave branch onto the slave — OR, if a checkout already exists (a prior/partial
// run, or the branch was deleted+recreated during iteration), hard-refresh it to the exact
// remote branch head. Without the refresh, `git clone` would fail on a non-empty dir and a
// stale checkout would make setup.sh run OLD install code (the "cancelled by user" trap).
// The refresh needs the PAT too (private repo fetch) — the askpass helper carries it.
export function cloneSlaveScript(o: { domain: string; repoUrl: string; askpassPath: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export GIT_ASKPASS="${o.askpassPath}"
export GIT_TERMINAL_PROMPT=0
# The slave's checkout dir is DERIVED from the repo URL basename — exactly the name a plain
# 'git clone' produces — so it tracks the repo name automatically (hostyour-cloud), never hardcoded.
name=$(basename "${o.repoUrl}" .git)
RD="$HOME/$name"
if [ -d "$RD/.git" ]; then
  git -C "$RD" remote set-url origin "${o.repoUrl}"
  git -C "$RD" fetch --prune origin "${o.domain}"
  git -C "$RD" checkout -B "${o.domain}" "origin/${o.domain}"
  git -C "$RD" reset --hard "origin/${o.domain}"
else
  git clone --branch "${o.domain}" "${o.repoUrl}" "$RD"
fi
`;
}

// create-mgmt (step 4) runs `setup.sh --slave-add` out of the MASTER's LIVE ~/hostyour-cloud
// checkout — the ONE working tree in the whole run nothing else keeps current (the slave's
// checkout is clone-or-hard-refreshed by step 3; prepare-branch/gitops-handoff work in
// ~/slave-work scratch clones; --emit-mgmt-credentials runs on the SLAVE). A stale master
// checkout runs OLD installer code — the live incident: ~/hostyour-cloud sat 13 commits behind
// the install branch, still pre-rename, with NO --slave-add flag, and step 4 died on it. So
// refresh it FIRST, deterministically, to the head of the master's own install branch
// (branch == the master's FQDN — the one-branch-per-host discipline; the same value
// masterFqdnOf feeds the git-branch lock, so the refresh runs under that lock).
// fetch + reset --hard + checkout -B is prepare-branch's exact idiom: idempotent, and
// `checkout -B` also HEALS a wrong-branch checkout (name AND content), not just a stale one.
// Neither reset --hard nor checkout -B touches gitignored untracked files, so the master's
// base/secrets/* (secrets.<stage> — the --slave-secrets input — and vault-<stage>.txt, both
// gitignored in hostyour-cloud) survive by construction (the live run confirmed it).
// stdout contract: one `CHECKOUT_HEAD <old> <new>` line (short HEADs — secret-free).
// The branch is always the host's own FQDN.
export function refreshCheckoutScript(branch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${RESOLVE_REPO_DIR}
old=$(git -C "$GITOPS_DIR" rev-parse --short HEAD)
git -C "$GITOPS_DIR" fetch origin
git -C "$GITOPS_DIR" reset --hard
git -C "$GITOPS_DIR" checkout -B "${branch}" "origin/${branch}"
new=$(git -C "$GITOPS_DIR" rev-parse --short HEAD)
echo "CHECKOUT_HEAD $old $new"
`;
}

/** WHERE the deployment programs read and write the platform tree. Not discovered like the $HOME
 *  checkout above: the programs (digita-deploy ansiwise/programs/) name this path on every
 *  `repository:` row, so a refresh that fed them has to stand exactly where they read. */
export const PLATFORM_CHECKOUT = "/srv/hostyour-cloud";

// The same refresh for the PROGRAMS' checkout at /srv/hostyour-cloud — the tree deploy-branch
// generated and regenerate-branch / deploy-cluster / deploy-gitops act on. Two scripts because the
// two worlds keep their checkout in two places: the shell-driven slave verbs discover theirs under
// $HOME (RESOLVE_REPO_DIR above), the ansiwise programs name /srv/hostyour-cloud outright. `fetch
// --tags` because a release needs two refs the local clone does not have yet: the pin commit the
// manager pushed onto the install branch, and the release tag it minted on the trunk — the tag is
// what regenerate-branch merges, and its git_merge_ref deliberately fetches nothing itself.
// Same idempotent fetch + reset --hard + checkout -B idiom, same CHECKOUT_HEAD stdout contract.
export function refreshPlatformCheckoutScript(branch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ -d "${PLATFORM_CHECKOUT}/.git" ] || { echo "no platform checkout at ${PLATFORM_CHECKOUT} — deploy-branch puts it there; has this machine been installed through the deployment programs?" >&2; exit 3; }
old=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
git -C "${PLATFORM_CHECKOUT}" fetch origin --tags
git -C "${PLATFORM_CHECKOUT}" reset --hard
git -C "${PLATFORM_CHECKOUT}" checkout -B "${branch}" "origin/${branch}"
new=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
echo "CHECKOUT_HEAD $old $new"
`;
}

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
