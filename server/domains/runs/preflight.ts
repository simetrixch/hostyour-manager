// The adopt preflight checks. Two halves:
//   1. PREFLIGHT_SCRIPT — a self-contained bash script of checks, uploaded + run over SSH (step 1).
//      It emits one `CHECK <id> <PASS|WARN|FAIL> <detail>` line per check, one
//      `NIC <iface> <addr>` line per global-scope IPv4 interface, one
//      `PORT <port> listener=<yes|no> connect=<address|no>` line per ingress port, plus a single
//      `PUBLIC_IP <ip>` line (feeds dns.wildcard + the baseline step).
//   2. parsePreflightOutput / makeCheck — turn those lines (and the runner-added checks
//      sudo.ok / dns.wildcard / net.inbound) into typed PreflightChecks via one catalog.
// Pure module (no ssh2, no db): unit-testable; the adopt run def wires it to a session.
//
// WHY THE INGRESS PORTS ARE THE ONE CHECK THE SCRIPT DOES NOT JUDGE. Every other check reaches its
// verdict on the machine and ships the answer; `port.80` and `port.443` ship the two MEASUREMENTS and
// are judged here, in `portCheck`. The verdict is what was wrong about them, and a verdict written in
// the script is a verdict no test in this repository can plant a defect in — the script's first and
// only reader is bash on somebody's host.
import type { PreflightCheck, PreflightSeverity, PreflightStatus } from "../../../shared/preflight.ts";

interface CatalogEntry {
  title: string;
  severity: PreflightSeverity;
  hint?: string; // shown when status !== "pass"
}

// One home for every check's title + severity + fix hint.
export const PREFLIGHT_CATALOG: Record<string, CatalogEntry> = {
  "os.ubuntu": { title: "Operating system", severity: "hard", hint: "hostyour-cloud requires Ubuntu 24.04 or 26.04." },
  "os.arch": { title: "CPU architecture", severity: "hard", hint: "MicroK8s needs x86_64 or aarch64." },
  "cpu.count": { title: "CPU cores", severity: "soft", hint: "≥4 vCPU recommended." },
  "mem.total": { title: "Memory", severity: "soft", hint: "≥8 GB RAM recommended." },
  "disk.free": { title: "Free disk space", severity: "soft", hint: "≥40 GB free recommended." },
  "sudo.ok": { title: "Sudo access", severity: "hard", hint: "Adopt as root, or grant the user sudo first." },
  "port.22": { title: "SSH port (22)", severity: "soft", hint: "sshd should be listening on :22." },
  "port.80": { title: "Port 80 free", severity: "soft", hint: "Traefik will own :80 — free it, or take a machine that is not already serving ingress." },
  "port.443": { title: "Port 443 free", severity: "soft", hint: "Traefik will own :443 — free it, or take a machine that is not already serving ingress." },
  "net.inbound": { title: "Inbound 80/443 reachable", severity: "soft", hint: "Open the firewall/SG: ufw allow 22,80,443/tcp." },
  "net.egress": { title: "Outbound internet", severity: "hard", hint: "The installer needs egress for the repo, snaps, and Let's Encrypt." },
  "dns.wildcard": { title: "DNS wildcard", severity: "soft", hint: "Add *.<domain> A <server-ip> (verified via 1.1.1.1)." },
  "snapd.present": { title: "snapd installed", severity: "soft", hint: "apt install snapd (provision can install it)." },
  "time.sync": { title: "Clock synchronized", severity: "soft", hint: "Enable NTP: timedatectl set-ntp true (TLS/LE dislike clock skew)." },
  // deploy-slave extra (the master's Vault must answer from the slave —
  // the per-slave KV mount lives there and slave-ESO authenticates against it.
  "vault.reachable": { title: "Master Vault reachable", severity: "hard", hint: "The slave must reach https://vault.<master-fqdn>:8200 — check DNS, routing, and the firewall." },
  // deploy-slave extra: the slave's pod (Calico) CIDR
  // must not overlap the cluster LAN, or manager pods can't route to the slave's LAN IP —
  // the `dial …:16443 i/o timeout` blocker. Mirrors hostyour-cloud base/lib/preflight.sh;
  // computed LOCALLY by the Manager (podCidrOverlapCheck), not the remote checks.
  "net.podcidr": { title: "Pod CIDR vs cluster LAN", severity: "hard", hint: "POD_CIDR (default 10.244.0.0/16) must be disjoint from the cluster LAN /24 (MicroK8s' stock 10.1.0.0/16 overlaps a 10.1.1.0/24 LAN)." },
};

/** Build a typed check from an id + outcome, attaching the catalog title/severity/hint. */
export function makeCheck(id: string, status: PreflightStatus, detail: string): PreflightCheck {
  const cat = PREFLIGHT_CATALOG[id] ?? { title: id, severity: "soft" as PreflightSeverity };
  const check: PreflightCheck = { id, title: cat.title, severity: cat.severity, status, detail };
  if (status !== "pass" && cat.hint) check.hint = cat.hint;
  return check;
}

// ---- the ingress ports: two measurements, one verdict -------------------------------------

/** What the machine answered about one of the ingress ports.
 *
 *  `listener` is what `ss -Hltn` found: a process holding the port open in USERSPACE.
 *  `answeredAt` is the address whose connection the machine accepted — its own loopback or one of
 *  its own global addresses — and `undefined` when every one of them refused. */
export interface PortReading {
  port: number;
  listener: boolean;
  answeredAt: string | undefined;
}

/**
 * IS THIS MACHINE ALREADY SERVING THE PORT? — which is not the same question as "is a socket
 * listening on it", and the difference is what lets a machine already carrying a whole installation
 * pass a check that exists to keep a second one off it.
 *
 * Measured on a master installation of this platform: `ss -Hltn "sport = :443"` found
 * nothing while a connection to the machine's own address on 443 was accepted and Traefik answered
 * 404. The Traefik Service is `type: LoadBalancer` with NodePorts behind it, so what serves 443 is a
 * DNAT programmed below the socket layer and there is no userspace listener for `ss` to find. The
 * port came back PASS, and `SLAVE_FAIL_ON_WARN` — the policy that turns "already bound" into a hard
 * refusal of a slave deploy — had nothing to promote.
 *
 * So a connection is what decides, and the socket reading is kept beside it rather than replaced: a
 * listener the connection could not reach (bound to one address, or a local firewall in the way) is
 * still something that owns the port. Either measurement finding the port taken is enough.
 *
 * THE DETAIL NAMES BOTH MEASUREMENTS, on a pass as much as on a warning. A card that said only "port
 * 443 free" would be the same sentence whether both measurements were made or neither, and the
 * machine that produced this finding is the one where those two readings disagree.
 */
export function portCheck(reading: PortReading): PreflightCheck {
  const { port, listener, answeredAt } = reading;
  const socket = listener ? "a socket is listening" : "no socket is listening";
  const connect = answeredAt === undefined
    ? "every connection to this machine's own addresses was refused"
    : `a connection to ${answeredAt} was accepted`;
  const taken = listener || answeredAt !== undefined;
  return makeCheck(`port.${port}`, taken ? "warn" : "pass",
    `port ${port} ${taken ? "is already served" : "is free"} — ${socket}, ${connect}`);
}

// ---- deploy-slave HARD policy (the slave must reach the master's Vault) --------------------
// Additive: adopt keeps consuming the raw parsed checks; only the deploy-slave run maps
// them through this policy.

/** Preflight checks whose WARN outcome is fatal on a SLAVE deploy: Traefik must own
 *  80/443 (`ingress` addon) and MicroK8s arrives via snap, so "port already served" /
 *  "snapd missing" — mere warnings at adopt time — mean the box cannot be deployed. */
export const SLAVE_FAIL_ON_WARN: ReadonlySet<string> = new Set(["port.80", "port.443", "snapd.present"]);

/** The deploy-slave severity re-map (shared/preflight.ts: soft checks are "re-evaluated
 *  as hard by the deploy preflight") — an adoptable box may still
 *  be un-deployable. Every check becomes `hard` (any FAIL now blocks), and the
 *  SLAVE_FAIL_ON_WARN warns are promoted to fails. Pure over the parsed checks. */
export function hardenPreflightForSlave(checks: PreflightCheck[]): PreflightCheck[] {
  return checks.map((c) => {
    const promoted = c.status === "warn" && SLAVE_FAIL_ON_WARN.has(c.id);
    const out: PreflightCheck = { ...c, severity: "hard", status: promoted ? "fail" : c.status };
    if (out.status !== "pass" && out.hint === undefined) {
      const hint = PREFLIGHT_CATALOG[c.id]?.hint;
      if (hint !== undefined) out.hint = hint;
    }
    return out;
  });
}

// ---- deploy-slave CIDR guard ----------------------
// The whole per-slave trio is "manager pods reach INTO the slave over the LAN". If the pod
// (Calico IPAM) network overlaps the cluster LAN, that traffic is swallowed by the CNI and the
// slave's API answers with `i/o timeout` — the failure this guard exists to catch. hostyour-cloud's installer now
// stamps a non-overlapping POD_CIDR and base/lib/preflight.sh hard-checks it; this is the
// Manager's LOCAL mirror — NOT a remote preflight check (no probe): the Manager already
// knows the cluster LAN (the /24 around the inventory lanHost) and the installer's default pod CIDR.

/** The pod (Calico) CIDR hostyour-cloud's installer now stamps: the
 *  conventional Kubernetes range, disjoint from the cluster LAN, the services CIDR and the WAN.
 *  Used as the assumed slave pod CIDR when the Manager can't know the box's actual value. */
export const DEFAULT_POD_CIDR = "10.244.0.0/16";

/** Parse a dotted-quad IPv4 into a 32-bit unsigned int; undefined if malformed. Pure. */
function parseIpv4(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** Parse "a.b.c.d/n" into a base int + prefix length; undefined if malformed / out of range. */
function parseCidr(cidr: string): { base: number; prefix: number } | undefined {
  const [addr, len, ...rest] = cidr.split("/");
  if (addr === undefined || len === undefined || rest.length > 0 || !/^\d{1,2}$/.test(len)) return undefined;
  const prefix = Number(len);
  const base = parseIpv4(addr);
  if (base === undefined || prefix > 32) return undefined;
  return { base, prefix };
}

/** True iff two IPv4 CIDR ranges intersect — they do exactly when they agree on the SHORTER
 *  of the two prefixes. Pure, allocation-free. */
function cidrsOverlap(a: { base: number; prefix: number }, b: { base: number; prefix: number }): boolean {
  const bits = Math.min(a.prefix, b.prefix);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; // the top `bits` bits; /0 ⇒ all space
  return ((a.base & mask) >>> 0) === ((b.base & mask) >>> 0);
}

/** Increment-0 CIDR guard: the slave's pod CIDR must be disjoint from the cluster LAN, or
 *  manager pods cannot route to the slave's LAN IP. The cluster LAN is
 *  the /24 around the inventory lanHost; the pod CIDR defaults to what the installer stamps.
 *  Returns undefined — the check is SKIPPED, never pushed — when lanHost is unknown or not an
 *  IPv4 (a NAT/FQDN inventory row yields no cluster LAN, and a skipped check must never read as a
 *  pass). Severity is hard via the catalog, so an overlap FAILS the deploy-slave preflight. */
export function podCidrOverlapCheck(lanHost: string | null | undefined, podCidr: string = DEFAULT_POD_CIDR): PreflightCheck | undefined {
  const lanIp = lanHost ? parseIpv4(lanHost) : undefined;
  const pod = parseCidr(podCidr);
  if (lanIp === undefined || pod === undefined) return undefined; // skip gracefully
  const lanBase = (lanIp & 0xffffff00) >>> 0; // the enclosing /24
  const lan = { base: lanBase, prefix: 24 };
  const lanCidr = `${(lanBase >>> 24) & 255}.${(lanBase >>> 16) & 255}.${(lanBase >>> 8) & 255}.0/24`;
  const overlaps = cidrsOverlap(pod, lan);
  return makeCheck("net.podcidr", overlaps ? "fail" : "pass",
    overlaps
      ? `pod CIDR ${podCidr} overlaps the cluster LAN ${lanCidr} (from lanHost ${lanHost}) — manager pods would not route to the slave`
      : `pod CIDR ${podCidr} is disjoint from the cluster LAN ${lanCidr} (from lanHost ${lanHost})`);
}

export interface ParsedPreflight {
  checks: PreflightCheck[];
  publicIp?: string;
  /** Every IPv4-bearing adapter (iface → addr/prefix, e.g. eth0 → 10.1.1.11/24), from the
   *  checks' NIC lines; `{}` when the checks emitted none (older script / no adapters). */
  nics: Record<string, string>;
}

/** Parse the checks' stdout into typed checks + the observed public IP. Robust to noise:
 *  non-CHECK lines are ignored; an unknown id degrades to a soft check titled by its id. */
export function parsePreflightOutput(stdout: string): ParsedPreflight {
  const checks: PreflightCheck[] = [];
  const nics: Record<string, string> = {};
  let publicIp: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const ipm = /^PUBLIC_IP (.+)$/.exec(line);
    if (ipm?.[1]) {
      const ip = ipm[1].trim();
      if (ip && ip !== "unknown") publicIp = ip;
      continue;
    }
    const nicm = /^NIC (\S+) (\S+)$/.exec(line);
    if (nicm?.[1] && nicm[2]) {
      nics[nicm[1]] = nicm[2];
      continue;
    }
    // The two readings of one ingress port, judged HERE and not on the machine — see portCheck.
    const portm = /^PORT (\d+) listener=(yes|no) connect=(\S+)$/.exec(line);
    if (portm?.[1] && portm[2] && portm[3]) {
      checks.push(portCheck({
        port: Number(portm[1]),
        listener: portm[2] === "yes",
        answeredAt: portm[3] === "no" ? undefined : portm[3],
      }));
      continue;
    }
    const m = /^CHECK (\S+) (PASS|WARN|FAIL) (.*)$/.exec(line);
    const id = m?.[1];
    const token = m?.[2];
    const detail = m?.[3];
    if (id === undefined || token === undefined || detail === undefined) continue;
    const status: PreflightStatus = token === "PASS" ? "pass" : token === "WARN" ? "warn" : "fail";
    checks.push(makeCheck(id, status, detail));
  }
  const result: ParsedPreflight = { checks, nics };
  if (publicIp !== undefined) result.publicIp = publicIp;
  return result;
}

/** One operator-facing run-log line showing EVERY network adapter, not just the public IP —
 *  e.g. "NICs: eth0=10.1.1.11/24  ens18=192.168.0.5/24 · public=203.0.113.7". Shared by the
 *  adopt preflight and the deploy-slave slave-preflight so both logs read identically. */
export function formatNicsLine(parsed: ParsedPreflight): string {
  const nics = Object.entries(parsed.nics).map(([iface, addr]) => `${iface}=${addr}`);
  return `NICs: ${nics.length > 0 ? nics.join("  ") : "none detected"} · public=${parsed.publicIp ?? "unknown"}`;
}

// The remote checks. Written brace-free + backslash-free on purpose so it survives a plain
// JS template literal (no ${...} interpolation, no \n). Best-effort: a missing tool degrades
// to WARN, never aborts. The thresholds are the ones hostyour-cloud's own installer preflight uses.
export const PREFLIGHT_SCRIPT = `#!/usr/bin/env bash
# adopt preflight checks. Emits: CHECK <id> <PASS|WARN|FAIL> <detail>, NIC <iface> <addr>, PUBLIC_IP <ip>.
emit() { echo "CHECK $1 $2 $3"; }

ID=; VERSION_ID=
if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "$ID" = "ubuntu" ]; then
    case "$VERSION_ID" in
      24.04|26.04) emit os.ubuntu PASS "ubuntu $VERSION_ID";;
      *) emit os.ubuntu WARN "ubuntu $VERSION_ID (untested; installer targets 24.04/26.04)";;
    esac
  else
    emit os.ubuntu FAIL "$ID $VERSION_ID (not Ubuntu)"
  fi
else
  emit os.ubuntu FAIL "no /etc/os-release"
fi

arch=$(uname -m 2>/dev/null || echo unknown)
case "$arch" in
  x86_64|aarch64) emit os.arch PASS "$arch";;
  *) emit os.arch FAIL "$arch (need x86_64 or aarch64)";;
esac

cores=$(nproc 2>/dev/null || echo 0)
if [ "$cores" -ge 4 ]; then emit cpu.count PASS "$cores cores"
elif [ "$cores" -ge 2 ]; then emit cpu.count WARN "$cores cores (>=4 recommended)"
else emit cpu.count FAIL "$cores cores (<2)"; fi

memkb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
[ -z "$memkb" ] && memkb=0
memgib=$(( memkb / 1048576 ))
if [ "$memkb" -ge 8388608 ]; then emit mem.total PASS "$memgib GiB"
elif [ "$memkb" -ge 4194304 ]; then emit mem.total WARN "$memgib GiB (>=8 recommended)"
else emit mem.total FAIL "$memgib GiB (<4)"; fi

avail_root=$(df -B1 --output=avail / 2>/dev/null | tail -1 | tr -d ' ')
[ -z "$avail_root" ] && avail_root=0
avail=$avail_root
if mountpoint -q /mnt/data 2>/dev/null; then
  avail_data=$(df -B1 --output=avail /mnt/data 2>/dev/null | tail -1 | tr -d ' ')
  [ -n "$avail_data" ] && [ "$avail_data" -gt "$avail" ] && avail=$avail_data
fi
availgb=$(( avail / 1000000000 ))
if [ "$availgb" -ge 40 ]; then emit disk.free PASS "$availgb GB free"
elif [ "$availgb" -ge 25 ]; then emit disk.free WARN "$availgb GB free (>=40 recommended)"
else emit disk.free FAIL "$availgb GB free (<25)"; fi

if ss -Hltn 'sport = :22' 2>/dev/null | grep -q .; then emit port.22 PASS "sshd listening"
else emit port.22 WARN "nothing listening on :22"; fi

# The ingress ports are MEASURED here and judged in portCheck. Two readings per port: a listening
# socket, and a connection the machine makes to itself. The connection is the one that finds an
# ingress served through a DNAT, which has no userspace socket for ss to see; it is tried against
# loopback first and then every global address the machine carries, because that DNAT is programmed
# against the address a client would use and not against 127.0.0.1.
selfaddrs=$(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
for p in 80 443; do
  listener=no
  if ss -Hltn "sport = :$p" 2>/dev/null | grep -q .; then listener=yes; fi
  answered=no
  for a in 127.0.0.1 $selfaddrs; do
    if timeout 2 bash -c "</dev/tcp/$a/$p" 2>/dev/null; then answered=$a; break; fi
  done
  echo "PORT $p listener=$listener connect=$answered"
done

if curl -4 -sI --max-time 8 https://github.com >/dev/null 2>&1; then emit net.egress PASS "github.com reachable"
else emit net.egress FAIL "cannot reach github.com"; fi

if command -v snap >/dev/null 2>&1; then emit snapd.present PASS "snap present"
else emit snapd.present WARN "snapd missing"; fi

if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then emit time.sync PASS "clock synced"
else emit time.sync WARN "clock not NTP-synced"; fi

ip -o -4 addr show scope global 2>/dev/null | awk '{print "NIC "$2" "$4}'

pip=$(curl -4 -s --max-time 5 https://api.ipify.org 2>/dev/null)
[ -z "$pip" ] && pip=unknown
echo "PUBLIC_IP $pip"
`;
