import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import { buildKubeConfig, KubeMasterArgoReader } from "./kube.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "./testing/fake.ts";
import type { ArgoAppStatus, ResolvedClusterKube } from "./port.ts";

const synced = (sha: string): ArgoAppStatus => ({ syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" });

// A minimal but VALID kubeconfig document for the file-override variant — loadFromFile parses and
// validates it for real, so the test proves the override path end-to-end (no stubbed loader).
const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
current-context: test
clusters:
  - name: test
    cluster:
      server: https://kubeconfig-file.example:6443
contexts:
  - name: test
    context:
      cluster: test
      user: test
users:
  - name: test
    user:
      token: filetoken
`;

// buildKubeConfig is the EXPLICIT input-variant dispatch (never loadFromDefault). Unlike the IO
// shells below it, it does no cluster IO — every loader only populates the KubeConfig object —
// so the dispatch is unit-testable here: loadFromCluster reads env/paths lazily and simply records
// the in-cluster SA file locations, which is exactly what these tests assert.
describe("buildKubeConfig (input-variant dispatch)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("{ kubeConfig } returns the pre-built config verbatim (tests/special wiring)", () => {
    const pre = new KubeConfig();
    pre.loadFromClusterAndUser({ name: "pre", server: "https://pre.example", skipTLSVerify: false }, { name: "u", token: "t" });
    expect(buildKubeConfig({ kubeConfig: pre })).toBe(pre);
  });

  it("{ kubeconfigPath } loads the file — the explicit dev/test override", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-kubecfg-"));
    dirs.push(dir);
    const file = join(dir, "kubeconfig.yaml");
    writeFileSync(file, KUBECONFIG_YAML, "utf8");
    const kc = buildKubeConfig({ kubeconfigPath: file });
    expect(kc.getCurrentCluster()?.server).toBe("https://kubeconfig-file.example:6443");
    expect(kc.getCurrentUser()?.token).toBe("filetoken");
  });

  it("{ inCluster: true } loads the pod ServiceAccount credentials (loadFromCluster)", () => {
    const kc = buildKubeConfig({ inCluster: true });
    // loadFromCluster's fixed shape: the inCluster context over the SA token/CA file paths — the
    // production mode since the Vault-mounted kubeconfig file was retired.
    expect(kc.getCurrentContext()).toBe("inClusterContext");
    expect(kc.getCurrentCluster()?.name).toBe("inCluster");
    expect(kc.getCurrentCluster()?.caFile).toBe("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
    expect(kc.getCurrentUser()?.authProvider?.name).toBe("tokenFile");
  });

  it("{ server, token, caData } builds the slave's cluster-admin bearer access (never skip-TLS)", () => {
    const kc = buildKubeConfig({ server: "https://10.1.1.11:16443", token: "bearer-tok", caData: "BASE64CA==" });
    expect(kc.getCurrentCluster()?.server).toBe("https://10.1.1.11:16443");
    expect(kc.getCurrentCluster()?.caData).toBe("BASE64CA==");
    expect(kc.getCurrentCluster()?.skipTLSVerify).toBe(false);
    expect(kc.getCurrentUser()?.token).toBe("bearer-tok");
    // The kubeconfig user NAME is asserted precisely because nothing else can
    // catch it drifting: the API server authenticates the token and never sees this name, so a name
    // that understates the credential — it read "manager-readonly" — fails no request and simply
    // misleads the next reader into believing a slave refuses cluster-scoped writes. Pinning it here
    // makes the honest name load-bearing.
    expect(kc.getCurrentUser()?.name).toBe("cluster-admin-bearer");
  });
});

// The watchApplication poll LOOP is pure control flow (deadline / until / failFast / poll) — only
// getApplication needs a live cluster, so the loop is unit-testable by stubbing that ONE method on a
// reader built from the file-override kubeconfig (no cluster IO at construction). This is the exact
// mechanism the phase-aware watch-sync fix relies on: a Failed/Error sync
// operation must stop the wait EARLY, while a Running one (a PreSync image build) must keep waiting.
describe("KubeMasterArgoReader.watchApplication (poll loop: until / failFast / budget)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A reader whose ONLY live method (getApplication) is replaced by a scripted queue; pollMs=1 so the
  // loop spins fast. The queue's last entry repeats once exhausted (a steady terminal observation).
  function stubbedReader(queue: ArgoAppStatus[]): { reader: KubeMasterArgoReader; calls: () => number } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-watch-"));
    dirs.push(dir);
    const file = join(dir, "kubeconfig.yaml");
    writeFileSync(file, KUBECONFIG_YAML, "utf8");
    const reader = new KubeMasterArgoReader({ kubeconfigPath: file }, 1);
    let calls = 0;
    reader.getApplication = async (): Promise<ArgoAppStatus | null> => {
      const s = queue[Math.min(calls, queue.length - 1)]!;
      calls += 1;
      return s;
    };
    return { reader, calls: () => calls };
  }

  const running = (): ArgoAppStatus => ({ syncRevision: null, targetRevision: null, sync: "OutOfSync", health: "Progressing", opPhase: "Running" });
  const failed = (): ArgoAppStatus => ({ syncRevision: null, targetRevision: null, sync: "OutOfSync", health: "Degraded", opPhase: "Failed" });
  const done = (sha: string): ArgoAppStatus => ({ syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy", opPhase: "Succeeded" });
  const until = (s: ArgoAppStatus): boolean => s.sync === "Synced" && s.health === "Healthy";
  const failFast = (s: ArgoAppStatus): boolean => s.opPhase === "Failed" || s.opPhase === "Error";

  it("FAILS FAST: a Failed sync operation stops the poll immediately (never waits out the budget)", async () => {
    const { reader, calls } = stubbedReader([failed()]);
    // A large budget: if fail-fast did not fire, this would spin for 60s and the test would hang.
    const s = await reader.watchApplication("argocd", "acme-prod", until, { timeoutMs: 60_000, failFast });
    expect(s.opPhase).toBe("Failed");
    expect(until(s)).toBe(false); // the caller (watch-sync) then throws
    expect(calls()).toBe(1); // observed once, stopped — no waiting
  });

  it("KEEPS WAITING while the sync is Running (a PreSync image build), then returns the Synced status", async () => {
    const sha = "a".repeat(40);
    const { reader, calls } = stubbedReader([running(), running(), done(sha)]);
    const s = await reader.watchApplication("argocd", "acme-prod", until, { timeoutMs: 60_000, failFast });
    expect(s.sync).toBe("Synced");
    expect(s.health).toBe("Healthy");
    expect(calls()).toBe(3); // Running did NOT trip failFast — it polled through to the Synced observation
  });

  it("without failFast, behavior is UNCHANGED: it waits out the budget and returns the last (unconverged) status", async () => {
    const { reader, calls } = stubbedReader([failed()]);
    // No failFast ⇒ even a Failed phase does not stop it early; it polls until the (tiny) budget.
    const s = await reader.watchApplication("argocd", "acme-prod", until, { timeoutMs: 20 });
    expect(until(s)).toBe(false);
    expect(calls()).toBeGreaterThan(1);
  });
});

describe("FakeMasterArgoReader", () => {
  it("returns the scripted Application status the watch converges on", async () => {
    const r = new FakeMasterArgoReader({ status: synced("a".repeat(40)) });
    const s = await r.watchApplication("argocd", "acme-prod", (x) => x.sync === "Synced" && x.health === "Healthy", { timeoutMs: 1000 });
    expect(s.sync).toBe("Synced");
    expect(s.health).toBe("Healthy");
    expect(s.syncRevision).toBe("a".repeat(40));
  });

  it("models a not-yet-synced app so `until` fails against it (a timeout)", async () => {
    const r = new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "OutOfSync", health: "Progressing" } });
    const until = (x: ArgoAppStatus) => x.sync === "Synced";
    const s = await r.watchApplication("argocd", "acme-prod", until, { timeoutMs: 10 });
    expect(until(s)).toBe(false);
  });
});

describe("FakeClusterReader", () => {
  it("reports a healthy smoke by default and a scripted failure on demand", async () => {
    const r = new FakeClusterReader();
    expect((await r.smoke("acme")).externalSecretsReady).toBe(true);
    r.setSmoke({
      namespaceExists: true,
      externalSecretsReady: false,
      workloads: [{ kind: "Deployment", name: "acme-web", available: false, desired: 1, ready: 0, message: "ImagePullBackOff" }],
    });
    const s = await r.smoke("acme");
    expect(s.externalSecretsReady).toBe(false);
    expect(s.workloads[0]?.message).toBe("ImagePullBackOff");
  });

  it("reads a scripted deploy-state (null when absent, so attest fails closed)", async () => {
    const r = new FakeClusterReader();
    expect(await r.readDeployState()).toBeNull();
    r.setDeployState({ domain: "s1.example", stage: "prod", writtenAt: "2026-07-13T00:00:00Z", generation: 3 });
    expect((await r.readDeployState())?.generation).toBe(3);
  });

});

describe("FakeClusterKubeResolver", () => {
  const master: ResolvedClusterKube = {
    clusterReader: new FakeClusterReader(),
    argoReader: new FakeMasterArgoReader(),
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  };

  it("returns the fallback resolution and records every clusterId asked", async () => {
    const r = new FakeClusterKubeResolver(master);
    expect(await r.resolve("cls_master")).toBe(master);
    expect(r.resolved).toEqual(["cls_master"]);
  });

  it("returns a per-clusterId override when scripted (a slave with its own reader + ns)", async () => {
    const r = new FakeClusterKubeResolver(master);
    const slave: ResolvedClusterKube = { ...master, clusterReader: new FakeClusterReader(), argoNamespace: "s1" };
    r.set("cls_s1", slave);
    expect(await r.resolve("cls_s1")).toBe(slave);
    expect(await r.resolve("cls_other")).toBe(master); // unscripted falls back
    expect(r.resolved).toEqual(["cls_s1", "cls_other"]);
  });
});
