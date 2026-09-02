import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { adoptDef } from "./defs/adopt.ts";
import { serverCredFlags } from "../inventory/write.ts";
import { readServerPasswordLogin } from "../../../shared/password-login.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { servers } from "../../db/schema/inventory.ts";
import { readServerTailnet } from "../../../shared/tailnet.ts";
import { readServerAuthorizedKeys } from "../../../shared/operator-keys.ts";
import { adoptWorkbench, fakeFactory, HEALTHY_PREFLIGHT, PASSWORD } from "./adopt.fixture.ts";

describe("adopt run — end to end through the executor", () => {
  const bench = adoptWorkbench();
  afterEach(() => bench.dispose());
  const make = bench.make;

  it("plans 12 steps with the password ceremony summary + required secret", async () => {
    const { executor } = make();
    const { plan } = await executor.plan("cluster-adopt", { serverId: "srv_adopt1" });
    // The two irreversible steps come after verify-key-login — never before it, since shutting the
    // password door is the change that can make a machine unreachable — and after every step that
    // can still fail on the host. A run that fails resets the row to `bare`, and a `bare` row offers
    // one-click adopt and refuses the password-login run kinds: correct only while the machine is still
    // as it was found, which is what their place at the end keeps true.
    expect(plan.steps.map((s) => s.name)).toEqual([
      "connect-password", "preflight", "generate-key", "install-key", "configure-sudo",
      "verify-key-login", "enable-ntp", "discard-password", "baseline",
      "disable-password-login", "purge-bootstrap-password", "register",
    ]);
    expect(plan.requiredSecrets).toEqual(["adopt-password"]);
    expect(plan.summary).toContain('Adopt server "s5"');
    expect(plan.warnings).toContain("DNS wildcard check will be skipped — no domain chosen yet.");
  });

  it("compensates in the order that keeps a host reachable: password back BEFORE the key goes", async () => {
    // Cleanups run in reverse REGISTRATION order (executor/cleanup.ts), and restore-password-login
    // is registered by the last of the three steps that register anything. So on an abort the
    // password door is open again before remove-sudoers takes away the sudo the restore itself
    // needs, and before remove-installed-key takes away the key.
    expect(adoptDef.cleanups?.({ serverId: "srv_adopt1" }).map((c) => c.name)).toEqual([
      "remove-installed-key", "remove-sudoers", "restore-password-login",
    ]);
  });

  it("adopts a healthy server to ready, seals a key, and never leaks the password", async () => {
    const { db, executor, store, serverId } = make();
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.every((s) => s.status === "ok")).toBe(true);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.status).toBe("ready");
    expect(server?.adoptedAt).not.toBeNull();
    expect((server?.preflightJson as { hostKey?: string }).hostKey).toBe("SHA256:fixture");

    const creds = await store.list({ serverId, kind: "ssh_key" });
    expect(creds).toHaveLength(1);
    expect(creds[0]?.publicKey).toMatch(/^ssh-ed25519 /);

    // Negative assertion: the password appears nowhere persisted.
    const dump = JSON.stringify(readEvents(db.db, runId)) + JSON.stringify(server) + JSON.stringify(run);
    expect(dump).not.toContain(PASSWORD);
  });

  it("leaves the server key-only: both doors shut, and the row says which run measured it", async () => {
    const { db, executor, store, serverId } = make();
    // The second door, as the list offers it: a bootstrap password sealed beside the server row so
    // adopt can be one click. Left standing, it outlives the adoption that needed it.
    await store.seal({
      kind: "other", label: "adopt password for s5", plaintext: Buffer.from(PASSWORD),
      fingerprint: "bootstrap-password", serverId,
    });
    expect((await serverCredFlags(store)).get(serverId)?.hasPassword).toBe(true);
    // Before any run: the column default. "unknown" says nothing was measured, which is the truth.
    expect(db.db.select().from(servers).where(eq(servers.id, serverId)).get()?.passwordLoginState).toBe("unknown");

    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // Door one: the daemon, as `sshd -T` reported it after the reload.
    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.passwordLoginState).toBe("off");
    const read = readServerPasswordLogin(server?.passwordLoginJson);
    expect(read.kind === "v0" && read.facts.runId).toBe(runId);
    expect(read.kind === "v0" && read.facts.passwordAuthentication).toBe("no");
    expect(read.kind === "v0" && read.facts.pubkeyAuthentication).toBe("yes");
    // Door two: the sealed copy is PURGED, not revoked — a revoked row keeps the blob, and the
    // blob is the password.
    expect((await serverCredFlags(store)).get(serverId)?.hasPassword).toBe(false);
    expect(await store.list({ serverId, kind: "other" })).toHaveLength(0);
    // And the key that replaced them is installed.
    expect(await store.list({ serverId, kind: "ssh_key" })).toHaveLength(1);
  });

  it("takes the FIRST authorized-keys reading, and a cloud image's own key reads as foreign", async () => {
    const { db, executor, serverId } = make();
    const before = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    // "unknown" is the column default and the one state no step writes.
    expect(before?.authorizedKeysState).toBe("unknown");
    expect(before?.authorizedKeysJson).toBeNull();

    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    // The image's provisioning key is still on the box, so the row must NOT read as clean — a
    // freshly adopted server nobody has looked at is exactly where such a key goes unseen.
    expect(server?.authorizedKeysState).toBe("unaccounted");
    const keys = readServerAuthorizedKeys(server?.authorizedKeysJson);
    expect(keys.kind).toBe("v0");
    if (keys.kind === "v0") {
      expect(keys.facts.runId).toBe(runId); // the reading names the run that took it
      // The line adopt itself wrote is known by its SEALED FINGERPRINT (the marker comment is
      // never consulted — anyone on the box can type it); the image's is known by nothing.
      expect(keys.facts.keys.map((k) => k.kind)).toEqual(["manager", "foreign"]);
      expect(keys.facts.keys[1]?.comment).toBe("someone@example.com");
    }
  });

  it("records the tailnet reading on the row — a host with no client reads 'no-client', with the run that read it", async () => {
    const { db, executor, serverId } = make();
    // Before any run: the column default, and no document. "unknown" is the honest reading of a
    // row nothing has looked at — it is the one state no step writes.
    const before = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(before?.tailnetState).toBe("unknown");
    expect(before?.tailnetJson).toBeNull();

    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.tailnetState).toBe("no-client");
    const read = readServerTailnet(server?.tailnetJson);
    expect(read.kind).toBe("v0");
    if (read.kind === "v0") {
      expect(read.facts.runId).toBe(runId); // the reading names the run that took it
      expect(read.facts.clientVersion).toBeNull();
      expect(read.facts.address).toBeNull();
      expect(read.facts.observedAt).toBeGreaterThan(0);
    }
  });

  it("a host already on the tailnet reads 'joined' with its address, version and coordinator", async () => {
    const joined = [
      "TAILNET client present",
      "TAILNET version 1.80.2",
      "TAILNET backend Running",
      "TAILNET address 100.71.4.9",
      "TAILNET coordinator https://tailnet.example.com",
    ].join("\n");
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, joined));
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.tailnetState).toBe("joined");
    const read = readServerTailnet(server?.tailnetJson);
    expect(read.kind === "v0" && read.facts.address).toBe("100.71.4.9");
    expect(read.kind === "v0" && read.facts.clientVersion).toBe("1.80.2");
    expect(read.kind === "v0" && read.facts.coordinator).toBe("https://tailnet.example.com");
  });

  it("a client that is installed but not logged in reads 'not-joined', never 'no-client'", async () => {
    const notJoined = ["TAILNET client present", "TAILNET version 1.80.2", "TAILNET backend NeedsLogin"].join("\n");
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, notJoined));
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.tailnetState).toBe("not-joined");
  });

  it("a client that would not answer reads 'client-unreadable' — the run never claims it measured a network", async () => {
    // Everything the client should have printed came back empty. Reading that as
    // "installed, no address ⇒ not joined" asserts as measured fact the exact thing the
    // run failed to measure.
    const silent = ["TAILNET client present", "TAILNET version 1.80.2", "TAILNET backend ", "TAILNET address "].join("\n");
    const { db, executor, serverId } = make(fakeFactory(HEALTHY_PREFLIGHT, silent));
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.tailnetState).toBe("client-unreadable");
  });

  it("fails on a wrong password and resets the server adopting → bare", async () => {
    const { db, executor, serverId } = make();
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from("wrong-password") });
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "connect-password")?.status).toBe("failed");
    const server = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect(server?.status).toBe("bare"); // onTerminal reset
  });

  it("blocks on a hard preflight failure (non-Ubuntu arch)", async () => {
    const bad = HEALTHY_PREFLIGHT.replace("CHECK os.arch PASS x86_64", "CHECK os.arch FAIL riscv64 (need x86_64 or aarch64)");
    const { db, executor, serverId } = make(fakeFactory(bad));
    const { runId } = await executor.plan("cluster-adopt", { serverId });
    await executor.approve(runId, { "adopt-password": Buffer.from(PASSWORD) });
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "preflight")?.status).toBe("failed");
    expect(db.db.select().from(servers).where(eq(servers.id, serverId)).get()?.status).toBe("bare");
  });
});
