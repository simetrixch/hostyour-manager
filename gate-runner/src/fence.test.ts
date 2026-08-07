// gate-runner/src/fence.test.ts — the sandbox self-probe. A fake ConnectFn is injected in every case, so
// no test touches the network. One case per way the attestation can come out: all-green, a broken fence (must-fail reachable),
// an unreachable must-pass, and target-string parsing. Two extra cases lock the fail-closed behaviour
// (empty must-fail list; a throwing connect).
import { describe, it, expect } from "vitest";
import { selfProbe } from "./fence.ts";
import type { ConnectFn, FenceConfig } from "./fence.ts";
import { SandboxAttestationSchema } from "../../shared/gates.ts";

const BASE: FenceConfig = {
  mustFailTargets: ["10.1.1.1:443", "traefik.lan:80"],
  controllerAddr: "controller.internal:8443",
  mustPassTarget: "github.com",
  confirmedListening: true,
};

/** A fake keyed on host: reachable() decides which hosts "connect". Records every call. */
function fakeConnect(reachable: (host: string) => boolean): { fn: ConnectFn; calls: Array<{ host: string; port: number }> } {
  const calls: Array<{ host: string; port: number }> = [];
  const fn: ConnectFn = async (host, port) => {
    calls.push({ host, port });
    return reachable(host);
  };
  return { fn, calls };
}

describe("fence.selfProbe", () => {
  // (1) must-fail + controllerAddr blocked, must-pass reachable => attestation all-green.
  it("attests all-green when the fence blocks the must-fail targets and the must-pass is reachable", async () => {
    const { fn } = fakeConnect((host) => host === "github.com");
    const att = await selfProbe(BASE, fn);

    expect(att.mustFailDenied).toBe(true);
    expect(att.controllerAddrDenied).toBe(true);
    expect(att.mustPassReached).toBe(true);
    expect(att.mustFailTargetsConfirmedListening).toBe(true); // echoed from cfg
    expect(att.mustFailTargets).toEqual(["10.1.1.1:443", "traefik.lan:80"]); // echoed verbatim
    // The attestation must satisfy the shared report contract.
    expect(() => SandboxAttestationSchema.parse(att)).not.toThrow();
  });

  // (2) a must-fail target is REACHABLE => the fence is broken => mustFailDenied false.
  it("reports mustFailDenied false when any must-fail target is reachable (fence broken)", async () => {
    const { fn } = fakeConnect((host) => host === "github.com" || host === "10.1.1.1");
    const att = await selfProbe(BASE, fn);

    expect(att.mustFailDenied).toBe(false);
    expect(att.controllerAddrDenied).toBe(true); // the other must-fail probe still held
    expect(att.mustPassReached).toBe(true);
  });

  // (3) the must-pass target is unreachable => mustPassReached false (the rest still green).
  it("reports mustPassReached false when the must-pass target cannot be reached", async () => {
    const { fn } = fakeConnect(() => false); // nothing reachable
    const att = await selfProbe(BASE, fn);

    expect(att.mustPassReached).toBe(false);
    expect(att.mustFailDenied).toBe(true);
    expect(att.controllerAddrDenied).toBe(true);
  });

  // (4) target parsing: a URL, a host:port, and a bare host resolve to the right host/port.
  it("parses URL, host:port, and bare-host targets into the right host and port", async () => {
    const { fn, calls } = fakeConnect((host) => host === "github.com");
    const cfg: FenceConfig = {
      mustFailTargets: ["https://10.1.1.1:443/"],
      controllerAddr: "host:8443",
      mustPassTarget: "github.com",
      confirmedListening: false,
    };
    await selfProbe(cfg, fn);

    expect(calls).toContainEqual({ host: "10.1.1.1", port: 443 }); // URL, default-port stripped
    expect(calls).toContainEqual({ host: "host", port: 8443 }); // explicit host:port
    expect(calls).toContainEqual({ host: "github.com", port: 443 }); // bare host => 443
  });

  // Fail-closed: an empty must-fail list proves nothing, so mustFailDenied is NOT vacuously true.
  it("does not treat an empty must-fail list as denied (fail closed)", async () => {
    const { fn } = fakeConnect((host) => host === "github.com");
    const att = await selfProbe({ ...BASE, mustFailTargets: [] }, fn);
    expect(att.mustFailDenied).toBe(false);
  });

  // Fail-closed: a connect that throws counts as not-denied / not-reached, never as a proven fence.
  it("treats a throwing connect as unprovable (never a proven fence)", async () => {
    const throwing: ConnectFn = async () => {
      throw new Error("probe blew up");
    };
    const att = await selfProbe(BASE, throwing);
    expect(att.mustFailDenied).toBe(false);
    expect(att.controllerAddrDenied).toBe(false);
    expect(att.mustPassReached).toBe(false);
  });

  // Regression: an http URL must be probed on port 80 (implicit or explicit), not the 443 default —
  // else an http://Traefik must-fail target would be probed on a closed 443 and vacuously "denied".
  it("defaults an http URL to port 80 and https to 443, keeping explicit ports", async () => {
    const { fn, calls } = fakeConnect(() => false);
    await selfProbe(
      {
        mustFailTargets: ["http://10.1.1.1", "http://traefik.lan:80"],
        controllerAddr: "https://c.internal",
        mustPassTarget: "https://github.com",
        confirmedListening: false,
      },
      fn,
    );
    expect(calls).toContainEqual({ host: "10.1.1.1", port: 80 }); // http implicit => 80
    expect(calls).toContainEqual({ host: "traefik.lan", port: 80 }); // http explicit 80
    expect(calls).toContainEqual({ host: "c.internal", port: 443 }); // https implicit => 443
    expect(calls).toContainEqual({ host: "github.com", port: 443 });
  });
});
