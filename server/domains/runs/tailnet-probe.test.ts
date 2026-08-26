import { describe, it, expect } from "vitest";
import { parseTailnetProbe, TAILNET_PROBE_SCRIPT } from "./tailnet-probe.ts";
import { tailnetReading } from "../../../shared/tailnet.ts";

const meta = { runId: "run_abc", observedAt: 1_700_000_000_000 };
const state = (stdout: string): string => tailnetReading(parseTailnetProbe(stdout), meta).state;

// What the probe prints on each kind of host, and the state that follows from it. These pin the
// one property the whole surface rests on: an absence the run MEASURED is told apart from an
// absence the run could not measure.
describe("parseTailnetProbe — an empty value is an absent fact, not a false one", () => {
  it("a host with no client emits one line and reads 'no-client'", () => {
    expect(state("TAILNET client absent")).toBe("no-client");
  });

  it("a joined host reads 'joined' and carries its address and coordinator", () => {
    const out = [
      "TAILNET client present",
      "TAILNET version 1.80.2",
      "TAILNET backend Running",
      "TAILNET address 100.71.4.9",
      "TAILNET coordinator https://tailnet.example.com",
    ].join("\n");
    const probe = parseTailnetProbe(out);
    expect(tailnetReading(probe, meta).state).toBe("joined");
    expect(probe.address).toBe("100.71.4.9");
    expect(probe.coordinator).toBe("https://tailnet.example.com");
  });

  it("a client that is not logged in reads 'not-joined' and keeps the state word it printed", () => {
    const out = ["TAILNET client present", "TAILNET version 1.80.2", "TAILNET backend NeedsLogin"].join("\n");
    expect(parseTailnetProbe(out).backendState).toBe("NeedsLogin");
    expect(state(out)).toBe("not-joined");
  });

  it("a client whose state could not be read reads 'client-unreadable', not 'not-joined'", () => {
    // `jq -r '… // empty'` prints an empty line for every unreadable field, so the emitted line has
    // a key and no value. That must land as "no such fact", which is what keeps a joined host whose
    // socket the login user cannot read from being recorded as a host on no network.
    const out = ["TAILNET client present", "TAILNET version 1.80.2", "TAILNET backend ", "TAILNET address "].join("\n");
    const probe = parseTailnetProbe(out);
    expect(probe.installed).toBe(true);
    expect(probe.backendState).toBeNull();
    expect(probe.address).toBeNull();
    expect(state(out)).toBe("client-unreadable");
  });

  it("a host that has the client but no jq emits no backend line at all — same outcome", () => {
    expect(state(["TAILNET client present", "TAILNET version 1.80.2"].join("\n"))).toBe("client-unreadable");
  });
});

describe("the probe script asks the client, not the address", () => {
  it("reads the backend state and the coordinator the installer's own reader reads", () => {
    // The three field names are the contract with the client, and the same three the installer
    // reads (hostyour-cloud base/lib/tailnet.sh). A rename that reached only one side would leave
    // every reading unreadable, silently.
    expect(TAILNET_PROBE_SCRIPT).toContain(".BackendState");
    expect(TAILNET_PROBE_SCRIPT).toContain(".Self.TailscaleIPs");
    expect(TAILNET_PROBE_SCRIPT).toContain(".ControlURL");
  });

  it("retries under sudo, because tailscaled's local socket is root-owned", () => {
    expect(TAILNET_PROBE_SCRIPT).toContain("sudo -n tailscale");
  });

  it("takes ONE field out of `debug prefs`, and never the block the private keys live in", () => {
    // `debug prefs` is the widest thing this probe runs as root. Measured at the client version an
    // installation ends up with (1.98.10): the daemon strips PrivateNodeKey, OldPrivateNodeKey and
    // NetworkLockKey out of the preferences before the local API answers, so what it prints is
    // settings. The field NAMES still stand in the output, under `Config`, and a later reading that
    // pulled anything out of that block would be reading a place key material has stood before —
    // through a run log and into an events row, where a redaction nobody wrote would have to catch
    // it. So the probe reads ControlURL and stops.
    const reads = [...TAILNET_PROBE_SCRIPT.matchAll(/ts debug prefs \| jq -r '([^']+)'/g)].map((m) => m[1]);
    expect(reads).toEqual([".ControlURL // empty"]); // exactly one reading, and it is the coordinator
    expect(TAILNET_PROBE_SCRIPT).not.toContain(".Config");
    expect(TAILNET_PROBE_SCRIPT).not.toContain("PrivateNodeKey");
    expect(TAILNET_PROBE_SCRIPT).not.toContain("NetworkLockKey");
  });
});
