import { describe, it, expect } from "vitest";
import { parsePreflightOutput, makeCheck, podCidrOverlapCheck, formatNicsLine, PREFLIGHT_CATALOG, PREFLIGHT_SCRIPT } from "./preflight.ts";
import { hasHardFailure, type PreflightReport } from "../../../shared/preflight.ts";

// A representative preflight run: a healthy-ish Ubuntu box with a couple of soft warnings.
const SAMPLE = [
  "CHECK os.ubuntu PASS ubuntu 26.04",
  "CHECK os.arch PASS x86_64",
  "CHECK cpu.count PASS 8 cores",
  "CHECK mem.total WARN 6 GiB (>=8 recommended)",
  "CHECK disk.free PASS 512 GB free",
  "CHECK port.22 PASS sshd listening",
  "CHECK port.80 PASS port 80 free",
  "CHECK port.443 PASS port 443 free",
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
