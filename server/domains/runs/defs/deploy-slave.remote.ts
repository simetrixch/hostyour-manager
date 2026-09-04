import { z } from "zod";
import { PLATFORM_CHECKOUT } from "./machine-state.ts";

// The REMOTE surface of the deploy-slave Run: the few shell scripts and kubectl commands the
// steps still ship to the two hosts, plus the contracts they parse back. Everything that BUILDS
// the slave is a deployment PROGRAM of the machine's own catalogue (hostyour-deploy
// ansiwise/programs/) driven over `ansiwise-rest serve` — what stands here is only what the manager
// does around those programs: git checkout upkeep, the credentials-file handover, and the
// verify/handoff kubectl reads. Pure string builders + zod contracts, no IO, no db: the def
// composes them, tests golden them.
//
// NOTHING HERE CARRIES A `sudo` OF ITS OWN, and that is a rule of this module rather than a
// property of any one builder. `microk8s kubectl` administers the cluster as root, so every one of
// these has to be raised — and the caller raises it, with the elevation password the run already
// asked for at approve (executor/stepkit.ts `raised`). A SCRIPT is therefore raised WHOLE: its
// kubectl lines carry no elevation each, because the first `sudo -S` would consume the password and
// leave the rest of the script prompting a terminal that is not there.
// The route that is NOT taken is `sudo -n`, answered only by a standing sudoers rule no run kind
// here writes and `remove-sudoers` takes off. A machine carries no such rule of this platform's
// making — a first master, installed by ansiwise-client, never had one — and the one row that used
// to grant these is granted to nobody now.

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

// The refresh for the PLATFORM checkout at /srv/hostyour-cloud — the tree the deployment programs
// act on and deliberately never fetch into themselves (a program acts on the tree it was pointed
// at; which state that tree stands on is the caller's to establish). `fetch --tags` so the tree
// carries every ref the catalogue's own programs may need: its branch regeneration merges a release
// tag out of this same tree. Idempotent fetch + reset --hard +
// checkout -B; `checkout -B` also HEALS a wrong-branch checkout (name AND content), not just a
// stale one. stdout contract: one `CHECKOUT_HEAD <old> <new>` line (short HEADs — secret-free).
export function refreshPlatformCheckoutScript(branch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ -d "${PLATFORM_CHECKOUT}/.git" ] || { echo "no platform checkout at ${PLATFORM_CHECKOUT} — this step moves that tree onto a branch and never creates it, and no step of this manager does either: a clone belongs on a git_clone row of a program, which reads its origin and its credential out of the machine's own settings files by name. Give the machine that row, or clone the tree onto it by hand, then run this again" >&2; exit 3; }
old=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
git -C "${PLATFORM_CHECKOUT}" fetch origin --tags
git -C "${PLATFORM_CHECKOUT}" reset --hard
git -C "${PLATFORM_CHECKOUT}" checkout -B "${branch}" "origin/${branch}"
new=$(git -C "${PLATFORM_CHECKOUT}" rev-parse --short HEAD)
echo "CHECKOUT_HEAD $old $new"
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

/** Every Application ArgoCD drives for a cluster, one `name|sync|health` row per line — the
 *  `argocd-follow` step's whole reading, and verify-slave's HARD gate 1. WHERE it runs is the
 *  caller's: a cluster carrying the master part operates its own ArgoCD in namespace `argocd` on
 *  itself, while a pure slave's Application CRs live in namespace <name> on the master. */
export function argoAppsCmd(name: string): string {
  return `microk8s kubectl -n ${name} get applications.argoproj.io -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.sync.status}{"|"}{.status.health.status}{"\\n"}{end}'`;
}

/** Every ExternalSecret in the slave's ArgoCD namespace ON THE MASTER, one
 *  `name|<Ready status>|<reason>` row per line (step 6 HARD gate 0). They materialize the
 *  instance's credentials out of the master's Vault, and the gate holds ALL of them rather than a
 *  list of names — a credential added to that chart must not slip past a reader that knows two.
 *  Without the repository credential the instance cannot even FETCH the private repo, and
 *  root-applications then sits at Unknown/Unknown, which is how the first live run died. Gate 0
 *  makes a stuck or failing ESO delivery a NAMED failure instead of that opaque timeout. */
export function externalSecretsCmd(name: string): string {
  return `microk8s kubectl -n ${name} get externalsecrets.external-secrets.io -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.status.conditions[?(@.type=="Ready")].reason}{"\\n"}{end}'`;
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
  return `microk8s kubectl -n ${name} annotate externalsecrets.external-secrets.io --all force-sync=$(date +%s) --overwrite`;
}

// The step-6 diagnostic bundle (master side, ns <name>) — run while a HARD gate is failing
// (rate-limited) and once right before it throws, so the run log always carries the ACTUAL
// reason a converge window expired (the first live run died as a bare `OutOfSync/Missing`
// timeout with none of this). SECRET-FREE by construction: names, labels, conditions,
// messages and pod phases only — never secret data (`get secrets --show-labels` prints no
// values). Every section tolerates absent resources (the `|| true` idiom): diagnostics must
// never fail the step themselves.
//
// IT READS NO SECRET, AND THAT IS DELIBERATE. ArgoCD registers a repository and a cluster by
// LABEL — a Secret in the instance's namespace carrying `argocd.argoproj.io/secret-type`. Reading
// those Secrets to prove the two are registered needs `get` on secrets, and Kubernetes RBAC has no
// grant that lists a Secret's name and labels while refusing its value: the same right serves
// `-o yaml`. So the registration is read off the ExternalSecrets that COMPOSE those Secrets
// instead — each one names its target Secret and the label it puts on it, and its Ready condition
// says whether ESO wrote it. Two facts, one right this platform already needs for the section
// above.
// WHAT THAT READING CANNOT SEE: the label on the Secret OBJECT. It reads the label the
// ExternalSecret asks for, which is what ESO writes and re-writes; a label edited onto the Secret
// by hand is reverted rather than reported. What it gains is the failure it exists for — a missing
// or wrong label is named WITH the ExternalSecret that carries it, where a Secret listing could
// only print nothing.
export function slaveDiagScript(name: string): string {
  const k = `microk8s kubectl -n ${name}`;
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
echo "-- argocd credential registration: externalsecret | target Secret | argocd.argoproj.io/secret-type | Ready"
${k} get externalsecrets.external-secrets.io -o jsonpath='{range .items[*]}{.metadata.name}{" | "}{.spec.target.name}{" | "}{.spec.target.template.metadata.labels["argocd\\.argoproj\\.io/secret-type"]}{" | "}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}' 2>&1 || true
echo "-- appprojects (root-applications references 'default' — created by the instance's argocd-server on boot)"
${k} get appprojects.argoproj.io -o name 2>&1 || true
echo "-- instance pods (manager/repo-server/redis must be Running for any comparison to succeed)"
${k} get pods --no-headers 2>&1 || true
echo "==== end diagnostics ===="
`;
}

/** Every ESO SecretStore ON THE SLAVE, `ns/name|<Ready status>` per line (step 6 HARD gate 2).
 *  A Ready SecretStore proves the whole per-slave Vault handshake end to end: ESO reached
 *  https://vault.<master>:8200, the kubernetes-<name> auth mount TokenReview'd the slave SA,
 *  the <name>-eso policy let it in. A missing policy binding is the classic failure here, and this
 *  surfaces it directly rather than as an opaque app failure later. Runs over the slave session — the run's ownsHost target. */
export const SECRET_STORES_CMD = `microk8s kubectl get secretstores.external-secrets.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'`;

/** Every cert-manager Certificate on the slave, same row shape (step 6 SOFT — LE issuance
 *  can lag on DNS propagation / rate limits; a pending cert is a note, not a failure). */
export const CERTS_CMD = `microk8s kubectl get certificates.cert-manager.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'`;

/** Parse `a|b|c` rows out of a kubectl jsonpath range dump, dropping blank lines. */
export function parsePipeRows(out: string): string[][] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split("|"));
}

// ---- what the machine is asked about ITSELF, and how the answer is read ---------------------
// Two readings the run takes off the host with one command each and turns into values a program or
// a cluster map is written from. They stand here for the same reason every builder above does: the
// command is a string and the reading is pure, so a test can plant a real machine's answer in it
// without a host — and the step that ships them (defs/deploy-slave.ts) keeps the IO.

/** The line separator, as a call rather than a literal. */
function chr10(): string { return String.fromCharCode(10); }

/** What is asked of a machine to find the disk its volumes belong on. `findmnt` reads the kernel's
 *  own mount table, so what comes back is what is mounted and not what somebody meant to mount.
 *
 *  THE MACHINE DOES THE DISCARDING, AND THAT IS NOT AN OPTIMISATION. What comes back of a command
 *  is its TAIL, and a cluster's own mount table runs to hundreds of lines — every pod subpath the
 *  container runtime binds appears in it. Asked unfiltered, the one line that matters sits at the
 *  top and scrolls out: the same machine answered "/mnt/data" before its cluster was installed and
 *  "no separate data disk" minutes later, with the disk still mounted (apps4, 2026-08-29). What is
 *  left here is short whatever the machine runs, and the reading below judges it again. */
export const DATA_DISK_COMMAND =
  "findmnt -rno TARGET,SOURCE | grep ' /dev/' | grep -v -e '^/ ' -e '^/boot' -e '^/snap' -e '^/var/snap' | head -20";

/** WHERE THE VOLUMES OF A CLUSTER BELONG: the machine's separate disk, if it carries one.
 *
 *  THIS WAS ASKED OF A PERSON AND THEREFORE FORGOTTEN. The three rows that place the volumes —
 *  require_storage_mount, create_storage_directory, link_storage_path — each do nothing when the
 *  answer is empty, and empty is what a form gets when nobody types a path. Measured on a master on
 *  2026-08-29: 29 GB of cluster data on the 124 GB boot disk while a 1 TB disk sat mounted at
 *  /mnt/data with 2.1 MB on it. Nothing reported it, because nothing had been asked.
 *
 *  WHAT COUNTS AS THAT DISK: a mount of a real block device that is neither the root filesystem nor
 *  a place the system keeps for itself. The boot partition is not it, and neither are the mounts the
 *  container runtime makes under a snap's tree — those are the cluster's own volumes appearing as
 *  mounts, and taking one would point the storage at itself. The shallowest remaining one wins,
 *  because a machine built with one data disk has exactly one and a nested mount is a part of it.
 *
 *  A MACHINE WITH NO SUCH DISK IS ANSWERED WITH NOTHING, and the three rows then skip exactly as
 *  they did before this existed. */
export function dataDiskFrom(mountTable: string): { storage_mount: string; storage_subdirectory: string } | undefined {
  const candidates: string[] = [];
  for (const line of mountTable.split(chr10())) {
    const [target, source] = line.trim().split(/\s+/);
    if (target === undefined || source === undefined) continue;
    if (!source.startsWith("/dev/")) continue;
    if (target === "/" || target.startsWith("/boot") || target.startsWith("/var/snap") || target.startsWith("/snap")) continue;
    candidates.push(target);
  }
  if (candidates.length === 0) return undefined;
  const shallowest = candidates.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]!;
  // NAMED, NOT THE MOUNT ITSELF. The link the cluster follows points at a directory ON that disk, so
  // the disk keeps a name of its own and what the cluster wrote is told apart from what else is
  // there — a mount pointed at directly is one nobody can put anything else on.
  return { storage_mount: shallowest, storage_subdirectory: `${shallowest}/microk8s-storage` };
}

/** WHERE THIS MACHINE CAN BE REACHED, each address on its own as a `/32`.
 *
 *  THE MASTER'S ADDRESSES USED TO STAND IN A SLAVE'S MAP. `global.nodeCidrs` is what the gate
 *  sandbox draws its fence from, and a slave's whole map is composed from the master's — so the
 *  fence around a slave named the master's machine and left the slave's own outside it. Nothing
 *  reported it: the list was not empty, so the reader that refuses to render on an empty list had
 *  something to render.
 *
 *  THE SAME READING measure_host_addresses takes on a master, because the two write one file and a
 *  second lifting of the same fact must not read it a second way: every global-scope IPv4 address
 *  the kernel lists, as a `/32` and not as the prefix it was configured with, minus loopback and
 *  minus the interfaces a container network makes and renumbers on its own schedule.
 *
 *  A /32 and not the interface's prefix: a node configured 10.1.1.7/24 shares that /24 with every
 *  other host on the wire, and what a boundary needs is the machine, not the segment. */
export const HOST_ADDRESS_COMMAND = "ip -4 -o addr show scope global";

/** The beginnings of the names of interfaces that are not the machine's — the same nine
 *  deploy-branch's own measure_host_addresses row passes over. Matched as PREFIXES, because every
 *  one of these families numbers or hashes its own. */
export const NOT_THE_MACHINES_INTERFACES = [
  "cali", "vxlan.calico", "tunl", "flannel", "cni", "docker", "br-", "veth", "kube-ipvs",
];

/** The `/32`s in a listing, in the order the kernel gave them.
 *
 *  Read by POSITION FROM THE `inet` MARKER and not by a fixed index, because the fields in front of
 *  it differ between an interface with a label and one without. */
export function hostAddressesFrom(listing: string): string[] {
  const found: string[] = [];
  for (const line of listing.split(chr10())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const at = fields.indexOf("inet");
    if (at < 0 || at + 1 >= fields.length) continue;
    const device = fields[1]!;
    if (NOT_THE_MACHINES_INTERFACES.some((prefix) => device.startsWith(prefix))) continue;
    const address = fields[at + 1]!.split("/")[0]!;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue;
    // Loopback is every host's own and identifies none of them, so a fence that carved it out would
    // carve out the caller's too.
    if (address.startsWith("127.")) continue;
    const cidr = `${address}/32`;
    if (!found.includes(cidr)) found.push(cidr);
  }
  return found;
}
