import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { VaultKvClient } from "./vault-kv.ts";
import { VaultError, type VaultConfig } from "./port.ts";

// WHAT A CALL THAT NEVER REACHED VAULT SAYS. Node answers such a call with `TypeError: fetch
// failed` and hangs the real failure off `cause`, so a log line built from the message alone reads
// the same for an untrusted certificate, a refused connection and a name that does not resolve.
// Those three need different actions from the operator. Every test below asserts the specific
// failure is IN the message; none of them would pass against the bare message.

let dir: string;
let saTokenPath: string;
let closedPort: number;

function cfg(addr: string): VaultConfig {
  return { addr, k8sRole: "manager", kvPrefix: "manager/cred", k8sAuthMount: "kubernetes-m1", saTokenPath };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vault-kv-"));
  saTokenPath = join(dir, "token");
  writeFileSync(saTokenPath, "a.projected.jwt\n");
  // A port nothing listens on, obtained by listening on one and giving it back. Asking the
  // operating system beats picking a number: a number this machine happens to serve would make
  // the test measure something else without saying so.
  closedPort = await new Promise<number>((resolve) => {
    const s: Server = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("adapters/vault/vault-kv — a call that never reached Vault names its cause", () => {
  it("names the refused connection, against a port nothing listens on", async () => {
    const addr = `http://127.0.0.1:${closedPort}`;
    const client = new VaultKvClient(cfg(addr));

    const err = await client.put("k", "dg==").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).message).toContain("ECONNREFUSED");
    expect((err as VaultError).message).toContain(addr);
    // The counter-probe: the bare message Node throws is not what a caller now reads.
    expect((err as VaultError).message).not.toBe("fetch failed");
  });

  it("names the certificate this process would not verify — the failure measured on an installation issuing from its own authority", async () => {
    const cause = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed", { cause })));
    const client = new VaultKvClient(cfg("https://vault.m1.example"));

    const err = await client.get("k").catch((e: unknown) => e);

    expect((err as VaultError).message).toContain("unable to verify the first certificate");
    expect((err as VaultError).message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  it("reaches through an AggregateError, whose own message is empty", async () => {
    // A host with an IPv6 and an IPv4 address fails once per address, and Node collects both under
    // an AggregateError carrying no message of its own. Reading `.message` there yields "".
    const inner = Object.assign(new Error("connect EHOSTUNREACH 2001:db8::1:8200"), { code: "EHOSTUNREACH" });
    const cause = new AggregateError([inner], "");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed", { cause })));
    const client = new VaultKvClient(cfg("https://vault.m1.example"));

    const err = await client.delete("k").catch((e: unknown) => e);

    expect((err as VaultError).message).toContain("EHOSTUNREACH");
  });

  it("names which call it was, so the seal and the login it needs first are told apart", async () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed", { cause })));
    const client = new VaultKvClient(cfg("https://vault.m1.example"));

    const err = await client.put("k", "dg==").catch((e: unknown) => e);

    // put() cannot run before the kubernetes login, so this is the login that failed.
    expect((err as VaultError).message).toContain("kubernetes login");
  });
});
