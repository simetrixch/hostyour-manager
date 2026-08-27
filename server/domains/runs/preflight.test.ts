import { describe, it, expect } from "vitest";
import { parsePreflightOutput, makeCheck, podCidrOverlapCheck, portCheck, formatNicsLine, hardenPreflightForSlave, PREFLIGHT_CATALOG, PREFLIGHT_SCRIPT } from "./preflight.ts";
import { hasHardFailure, type PreflightReport } from "../../../shared/preflight.ts";

// A representative preflight run: a healthy-ish Ubuntu box with a couple of soft warnings.
const SAMPLE = [
  "CHECK os.ubuntu PASS ubuntu 26.04",
  "CHECK os.arch PASS x86_64",
  "CHECK cpu.count PASS 8 cores",
  "CHECK mem.total WARN 6 GiB (>=8 recommended)",
  "CHECK disk.free PASS 512 GB free",
  "CHECK port.22 PASS sshd listening",
  "PORT 80 listener=no connect=no",
  "PORT 443 listener=no connect=no",
  "CHECK net.egress PASS github.com reachable",
  "CHECK snapd.present WARN snapd missing",
  "CHECK time.sync PASS clock synced",
  "NIC eth0 10.1.1.11/24",
  "NIC ens18 192.168.0.5/24",
  "PUBLIC_IP 203.0.113.7",
].join("\n");

describe("preflight parser", () => {
  it("parses every CHECK line into a typed check + extracts the public IP", () => {
    const { checks, publicIp } = parsePreflightOutput(SAMPLE);
    expect(publicIp).toBe("203.0.113.7");
    expect(checks).toHaveLength(11);
    const os = checks.find((c) => c.id === "os.ubuntu");
    expect(os).toMatchObject({ title: "Operating system", severity: "hard", status: "pass", detail: "ubuntu 26.04" });
    // a soft WARN carries its catalog hint
    const mem = checks.find((c) => c.id === "mem.total");
    expect(mem).toMatchObject({ severity: "soft", status: "warn" });
    expect(mem?.hint).toContain("8 GB");
  });

  it("attaches a hint only when the status is not pass", () => {
    expect(makeCheck("os.arch", "pass", "x86_64").hint).toBeUndefined();
    expect(makeCheck("os.arch", "fail", "riscv64").hint).toBe(PREFLIGHT_CATALOG["os.arch"]?.hint);
  });

  it("degrades an unknown check id to a soft check titled by its id", () => {
    const [c] = parsePreflightOutput("CHECK future.thing WARN whatever").checks;
    expect(c).toMatchObject({ id: "future.thing", title: "future.thing", severity: "soft", status: "warn" });
  });

  it("ignores noise and malformed lines", () => {
    const { checks } = parsePreflightOutput("hello\nCHECK\nCHECK os.arch PASS x86_64\n\nrandom");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.id).toBe("os.arch");
  });

  it("hasHardFailure blocks only on a hard check that failed", () => {
    const soft: PreflightReport = { checkedAt: 0, checks: [makeCheck("cpu.count", "fail", "1 core")] };
    expect(hasHardFailure(soft)).toBe(false); // soft fail rides along
    const hard: PreflightReport = { checkedAt: 0, checks: [makeCheck("os.arch", "fail", "riscv64")] };
    expect(hasHardFailure(hard)).toBe(true);
    const warn: PreflightReport = { checkedAt: 0, checks: [makeCheck("os.ubuntu", "warn", "ubuntu 22.04")] };
    expect(hasHardFailure(warn)).toBe(false); // a warn never blocks, even on a hard check
  });

  it("the checks script is self-contained bash that emits CHECK + NIC + PUBLIC_IP", () => {
    expect(PREFLIGHT_SCRIPT).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(PREFLIGHT_SCRIPT).toContain("emit os.ubuntu");
    expect(PREFLIGHT_SCRIPT).toContain("PUBLIC_IP");
    // one NIC line per global-scope IPv4 adapter (show every adapter, not just public IP)
    expect(PREFLIGHT_SCRIPT).toContain(`awk '{print "NIC "$2" "$4}'`);
  });

  it("turns each ingress port's two readings into its check, and judges them here rather than on the machine", () => {
    const { checks } = parsePreflightOutput([
      "PORT 80 listener=yes connect=127.0.0.1",
      "PORT 443 listener=no connect=203.0.113.7",
    ].join("\n"));
    expect(checks.map((c) => [c.id, c.status])).toEqual([["port.80", "warn"], ["port.443", "warn"]]);
    // The machine ships measurements; nothing in the line says pass or warn.
    expect(checks[1]?.detail).toContain("203.0.113.7");
  });

  it("parses NIC lines into the per-adapter map without polluting the checks", () => {
    const parsed = parsePreflightOutput(SAMPLE);
    expect(parsed.nics).toEqual({ "eth0": "10.1.1.11/24", "ens18": "192.168.0.5/24" });
    // NIC lines are not checks — the check count is unchanged by their presence
    expect(parsed.checks).toHaveLength(11);
  });

  it("formatNicsLine renders every adapter plus the public IP", () => {
    expect(formatNicsLine(parsePreflightOutput(SAMPLE)))
      .toBe("NICs: eth0=10.1.1.11/24  ens18=192.168.0.5/24 · public=203.0.113.7");
  });

  it("formatNicsLine degrades gracefully when the checks emitted no NIC/PUBLIC_IP lines", () => {
    expect(formatNicsLine(parsePreflightOutput("CHECK os.arch PASS x86_64")))
      .toBe("NICs: none detected · public=unknown");
  });
});

// THE INGRESS PORTS. The question is "does this machine already serve 80/443", and the check used to
// answer "is a socket listening on it" — which on a machine already carrying a whole installation of
// this platform is no. Measured on a master, 2026-08-26: `ss -Hltn "sport = :443"` found nothing
// while a connection to the machine's own address on 443 was accepted and Traefik answered 404. The
// Traefik Service is a LoadBalancer with NodePorts behind it, so what serves 443 is a DNAT below the
// socket layer with no userspace listener to find.
describe("portCheck", () => {
  // THE PLANTED DEFECT, in the shape the field produced it: an ingress served through a DNAT. Nothing
  // is listening and the machine still answers on the port, which is exactly the reading a check
  // asking `ss` alone reports as free.
  it("WARNS on a port served through a DNAT — nothing listening, and the machine still answered", () => {
    const c = portCheck({ port: 443, listener: false, answeredAt: "203.0.113.7" });
    expect(c).toMatchObject({ id: "port.443", severity: "soft", status: "warn" });
    expect(c.detail).toContain("203.0.113.7");
    expect(c.hint).toBeDefined();
  });

  // …and the hard policy it exists to arm: on a slave deploy that warning is a refusal, so a machine
  // already serving ingress cannot be deployed onto. Without this the case above would be a warning
  // nothing acts on.
  it("that warning is a HARD failure on a slave deploy — the machine cannot be deployed onto", () => {
    const hard = hardenPreflightForSlave([portCheck({ port: 443, listener: false, answeredAt: "203.0.113.7" })]);
    expect(hard[0]).toMatchObject({ id: "port.443", severity: "hard", status: "fail" });
    expect(hasHardFailure({ checkedAt: 0, checks: hard })).toBe(true);
  });

  // THE INNOCENT NEIGHBOUR: a bare machine, both readings empty. Without it the case above could mean
  // the check simply warns on every port it is asked about.
  it("PASSES a bare machine — no socket listening and every connection refused", () => {
    const c = portCheck({ port: 443, listener: false, answeredAt: undefined });
    expect(c).toMatchObject({ id: "port.443", status: "pass" });
    expect(c.hint).toBeUndefined(); // pass ⇒ no hint (makeCheck contract)
    expect(hasHardFailure({ checkedAt: 0, checks: hardenPreflightForSlave([c]) })).toBe(false);
  });

  it("WARNS on a listener the connection could not reach — a socket bound to one address still owns the port", () => {
    expect(portCheck({ port: 80, listener: true, answeredAt: undefined }).status).toBe("warn");
    expect(portCheck({ port: 80, listener: true, answeredAt: "127.0.0.1" }).status).toBe("warn");
  });

  // Which of the two measurements produced the verdict is on the card, on a pass as much as on a
  // warning: "port 443 free" reads the same whether both readings were taken or neither, and the
  // machine that produced this finding is the one where the two disagree.
  it("names BOTH measurements in every detail, whatever the verdict", () => {
    for (const reading of [
      { port: 443, listener: false, answeredAt: undefined },
      { port: 443, listener: false, answeredAt: "203.0.113.7" },
      { port: 443, listener: true, answeredAt: undefined },
      { port: 443, listener: true, answeredAt: "203.0.113.7" },
    ]) {
      const { detail } = portCheck(reading);
      expect(detail, JSON.stringify(reading)).toMatch(/socket is listening/);
      expect(detail, JSON.stringify(reading)).toMatch(/connection/);
    }
  });
});

describe("podCidrOverlapCheck", () => {
  it("passes when the default pod CIDR is disjoint from the cluster LAN /24", () => {
    const c = podCidrOverlapCheck("10.1.1.11");
    expect(c).toMatchObject({ id: "net.podcidr", title: "Pod CIDR vs cluster LAN", severity: "hard", status: "pass" });
    expect(c?.detail).toContain("10.1.1.0/24");
    expect(c?.hint).toBeUndefined(); // pass ⇒ no hint (makeCheck contract)
  });

  it("fails HARD when the pod CIDR encloses the cluster LAN — the collision seen in the field", () => {
    const c = podCidrOverlapCheck("10.1.1.11", "10.1.0.0/16"); // MicroK8s' stock default
    expect(c).toMatchObject({ id: "net.podcidr", severity: "hard", status: "fail" });
    expect(c?.hint).toBeDefined();
    expect(hasHardFailure({ checkedAt: 0, checks: c ? [c] : [] })).toBe(true);
  });

  it("fails when the default pod CIDR's /16 swallows a 10.244.x cluster LAN", () => {
    expect(podCidrOverlapCheck("10.244.5.9")?.status).toBe("fail");
  });

  it("skips gracefully (undefined, never a pass) when lanHost is unknown or not an IPv4", () => {
    expect(podCidrOverlapCheck(null)).toBeUndefined();
    expect(podCidrOverlapCheck(undefined)).toBeUndefined();
    expect(podCidrOverlapCheck("")).toBeUndefined();
    expect(podCidrOverlapCheck("s1.example.com")).toBeUndefined();
    expect(podCidrOverlapCheck("10.1.1")).toBeUndefined();
    expect(podCidrOverlapCheck("10.1.1.11", "not-a-cidr")).toBeUndefined();
  });
});
