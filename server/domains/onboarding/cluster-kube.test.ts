import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { ClusterPlaneV0 } from "../../../shared/plane.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import type { ClusterReader } from "../../adapters/kube/port.ts";
import { EMIT_ARGOCD_TOKEN, EMIT_REVIEWER_TOKEN, PARAMS, makeHarness, disposeHarnesses, bareStepCtx } from "../runs/deploy-slave.fixture.ts";
import { credLabels, sealTokenOnce, statedTarget } from "../runs/defs/deploy-slave.kit.ts";
import { registerStep } from "../runs/defs/deploy-slave.verify.ts";
import { makeClusterKubeResolver, type ClusterKubeDeps, type SlaveClusterInput } from "./cluster-kube.ts";

// A plaintext store (keyfile/vault off) is enough — we only need seal/open round-tripping the bearer.
const logger = createLogger(parseConfig({
  PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent", CONTROLLER_VERSION: "test",
} as unknown as NodeJS.ProcessEnv));

// The master-local trio the resolver reuses verbatim for the master path and as the
// argoReader/projectWriter for EVERY path — distinct instances so the tests can assert identity.
const masterReader = new FakeClusterReader();
const masterArgo = new FakeMasterArgoReader();
const masterProjects = new FakeMasterProjectWriter();

describe("domains/onboarding/cluster-kube — per-cluster kube resolver ", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(): { db: DbHandle; store: CredentialStore } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-clusterkube-"));
    dirs.push(dir);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    return { db: h, store: new CredentialStore({ db: h.db, logger }) };
  }

  // Record every SlaveClusterInput the resolver builds, so a test can assert the URL/token/caData.
  function spyDeps(db: DbHandle, store: CredentialStore): {
    deps: ClusterKubeDeps;
    built: SlaveClusterInput[];
    slaveReader: FakeClusterReader;
  } {
    const built: SlaveClusterInput[] = [];
    const slaveReader = new FakeClusterReader();
    const deps: ClusterKubeDeps = {
      db: db.db,
      master: { clusterReader: masterReader, argoReader: masterArgo, projectWriter: masterProjects },
      openCredential: (id) => store.open(id, { purpose: "test" }),
      buildClusterReader: (input): ClusterReader => {
        built.push(input);
        return slaveReader;
      },
    };
    return { deps, built, slaveReader };
  }

  function seedMasterCluster(db: DbHandle, role: "master" | "master+slave" = "master"): string {
    db.db.insert(servers).values({ id: "srv_master", name: "m1", host: "m1.example", sshUser: "ops", role, status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_master", serverId: "srv_master", stage: "prod", domain: "m1.example", status: "active", planeState: "ready" }).run();
    return "cls_master";
  }

  async function seedSlaveCluster(db: DbHandle, store: CredentialStore, opts: { plane: unknown }): Promise<string> {
    // The server row MUST exist before sealing: credentials.serverId is an FK to servers.id.
    db.db.insert(servers).values({ id: "srv_s1", name: "s1", host: "s1.example", lanHost: "10.1.1.11", sshUser: "ops", role: "slave", status: "healthy" }).run();
    const bearer = await store.seal({ kind: "kubeconfig", label: "s1-bearer", plaintext: Buffer.from("slave-admin-token"), fingerprint: "fp1", serverId: "srv_s1" });
    // Substitute the just-sealed credential id into the plane if the fixture asked for it.
    const plane = typeof opts.plane === "object" && opts.plane !== null && "credentialIds" in opts.plane
      ? { ...(opts.plane as Record<string, unknown>), credentialIds: { clusterBearer: bearer.id } }
      : opts.plane;
    db.db.insert(clusters).values({ id: "cls_s1", serverId: "srv_s1", stage: "prod", domain: "s1.example", status: "active", slaveId: 1, planeState: "ready", planeJson: plane }).run();
    return "cls_s1";
  }

  // The real ClusterPlaneV0 shape (shared/plane.ts): kube {server, caData} + argo {namespace,...}.
  const fullSlavePlane = {
    v: 0, branch: "s1.example", slaveId: 1,
    argo: { namespace: "s1", appName: "s1-apps" },
    kube: { server: "https://100.64.0.11:16443", caData: "BASE64CA==" },
    credentialIds: { clusterBearer: "placeholder", reviewerJwt: "rev" },
  };

  it("master cluster → the master-local trio verbatim + argoNamespace 'argocd' (behavior-identical)", async () => {
    const { db, store } = setup();
    const id = seedMasterCluster(db);
    const { deps, built } = spyDeps(db, store);
    const r = await makeClusterKubeResolver(deps).resolve(id);
    expect(r.clusterReader).toBe(masterReader);
    expect(r.argoReader).toBe(masterArgo);
    expect(r.projectWriter).toBe(masterProjects);
    expect(r.argoNamespace).toBe("argocd");
    expect(built).toHaveLength(0); // no per-slave client built for the master
  });

  it("master+slave takes the SAME master branch: pod SA, ns 'argocd', and NO bearer harvested for its own cluster", async () => {
    // The union role is a regular role. Its own cluster is the one the controller pod already sits on,
    // so a per-cluster client over a harvested cluster-admin bearer would be a second, sealed copy of
    // the access it has anyway — and there is no plane on a self-cluster to build one from.
    const { db, store } = setup();
    const id = seedMasterCluster(db, "master+slave");
    const { deps, built } = spyDeps(db, store);
    const r = await makeClusterKubeResolver(deps).resolve(id);
    expect(r.clusterReader).toBe(masterReader);
    expect(r.argoNamespace).toBe("argocd");
    expect(built).toHaveLength(0);
  });

  it("slave cluster → per-slave clusterReader over plane.kube + unsealed bearer + caData; argo/projects stay master-local, ns == slave name", async () => {
    const { db, store } = setup();
    const id = await seedSlaveCluster(db, store, { plane: fullSlavePlane });
    const { deps, built, slaveReader } = spyDeps(db, store);
    const r = await makeClusterKubeResolver(deps).resolve(id);
    expect(r.clusterReader).toBe(slaveReader);
    expect(r.argoReader).toBe(masterArgo); // master-local: the slave's Application CRs live on the master
    expect(r.projectWriter).toBe(masterProjects);
    expect(r.argoNamespace).toBe("s1"); // the per-slave ArgoCD namespace on the master
    expect(built).toHaveLength(1);
    expect(built[0]).toEqual({ server: "https://100.64.0.11:16443", token: "slave-admin-token", caData: "BASE64CA==" });
  });

  it("reads the API server straight from plane.kube.server (no lan derivation)", async () => {
    const { db, store } = setup();
    const altServer = { ...fullSlavePlane, kube: { server: "https://10.1.1.99:16443", caData: "BASE64CA==" } };
    const id = await seedSlaveCluster(db, store, { plane: altServer });
    const { deps, built } = spyDeps(db, store);
    await makeClusterKubeResolver(deps).resolve(id);
    expect(built[0]?.server).toBe("https://10.1.1.99:16443"); // verbatim from plane.kube.server
  });

  it("argoNamespace falls back to the cluster's SHORT NAME when plane.argo is absent", async () => {
    const { db, store } = setup();
    const noArgo = { v: 0, branch: "s1.example", slaveId: 1, kube: { server: "https://10.1.1.11:16443", caData: "BASE64CA==" }, credentialIds: { clusterBearer: "placeholder", reviewerJwt: "rev" } };
    const id = await seedSlaveCluster(db, store, { plane: noArgo });
    const { deps } = spyDeps(db, store);
    const r = await makeClusterKubeResolver(deps).resolve(id);
    expect(r.argoNamespace).toBe("s1"); // clusterShortName of clusters.domain, never servers.name
  });

  it("slave WITHOUT sealed kube access (plane.kube) → typed VALIDATION error (never skip-TLS)", async () => {
    const { db, store } = setup();
    const noKube = { v: 0, branch: "s1.example", slaveId: 1, credentialIds: { clusterBearer: "placeholder", reviewerJwt: "rev" } };
    const id = await seedSlaveCluster(db, store, { plane: noKube });
    const { deps } = spyDeps(db, store);
    await expect(makeClusterKubeResolver(deps).resolve(id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("no sealed kube access"),
    });
  });

  // The version is checked before the permissive subset, and this is the case that makes it matter.
  // A later version's document still satisfies the subset (clusterBearer is all it requires), and
  // every optional field the subset asks for by its v0 name reads as absent — `argo` among them,
  // which would take the fallback below and put the AppProject in a namespace no ArgoCD watches
  // while the log line says it was created. Refused, that cannot happen.
  it("slave whose plane carries a version this build does not know → typed VALIDATION error, not the fallback namespace", async () => {
    const { db, store } = setup();
    const future = { ...fullSlavePlane, v: 1, argo: undefined };
    const id = await seedSlaveCluster(db, store, { plane: future });
    const { deps } = spyDeps(db, store);
    await expect(makeClusterKubeResolver(deps).resolve(id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("management plane of version 1"),
    });
  });

  it("slave with an empty plane_json → typed 'no management plane' error", async () => {
    const { db, store } = setup();
    db.db.insert(servers).values({ id: "srv_s1", name: "s1", host: "s1.example", lanHost: "10.1.1.11", sshUser: "ops", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_s1", serverId: "srv_s1", stage: "prod", domain: "s1.example", status: "planned", slaveId: 1 }).run();
    const { deps } = spyDeps(db, store);
    await expect(makeClusterKubeResolver(deps).resolve("cls_s1")).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("no management plane"),
    });
  });

  it("unknown clusterId → NOT_FOUND", async () => {
    const { db, store } = setup();
    const { deps } = spyDeps(db, store);
    await expect(makeClusterKubeResolver(deps).resolve("cls_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("zeroes the transient bearer buffer after building the slave client", async () => {
    const { db, store } = setup();
    const id = await seedSlaveCluster(db, store, { plane: fullSlavePlane });
    let seen: Buffer | undefined;
    const { deps, built } = spyDeps(db, store);
    // Wrap openCredential to capture the buffer the resolver receives, then verify it is zeroed.
    const inner = deps.openCredential;
    deps.openCredential = async (credId) => { const buf = await inner(credId); seen = buf; return buf; };
    await makeClusterKubeResolver(deps).resolve(id);
    expect(built).toHaveLength(1);
    expect(seen && seen.every((b) => b === 0)).toBe(true); // buffer.fill(0) ran in the finally
  });
});

describe("domains/onboarding/cluster-kube over the plane the deploy-slave run wrote", () => {
  afterEach(disposeHarnesses);

  // The one test whose plane document is not hand-written. A fixture cannot catch a reader that asks
  // for a field name the writer never wrote — the fixture gets edited in the same change as the
  // reader and the suite stays green — which is exactly how a reader here once asked for two fields
  // the schema never declared and silently took its fallback on every row. So the document is
  // produced by the REAL writer: the register step itself, driven over the state create-mgmt leaves
  // behind (the sealed pair through the run's own sealTokenOnce, the kube facts on the cluster row
  // in create-mgmt's exact write shape). The full journey needs a live `ansiwise serve` and lives in
  // redeploy.ansiwise.test.ts, which parses the same plane after a whole run.
  it("resolves a slave from the document register actually wrote, with the values it wrote", async () => {
    const { db, store } = await makeHarness();
    db.db.insert(clusters).values({
      id: "cls_s1", serverId: "srv_slave1", stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
      planeJson: { kube: { server: "https://100.64.0.11:16443", caData: "TFMtQ0EtREFUQQ==" } },
    }).run();
    const ctx = bareStepCtx(db, store);
    const labels = credLabels("s1");
    await sealTokenOnce(ctx, { kind: "kubeconfig", label: labels.bearer, serverId: "srv_slave1", token: EMIT_ARGOCD_TOKEN });
    await sealTokenOnce(ctx, { kind: "other", label: labels.reviewer, serverId: "srv_slave1", token: EMIT_REVIEWER_TOKEN });
    await registerStep(statedTarget("srv_slave1", PARAMS.domain, "prod")).run(ctx);

    const row = db.db.select().from(clusters).where(eq(clusters.domain, PARAMS.domain)).get()!;
    const written = ClusterPlaneV0.parse(row.planeJson);

    const built: SlaveClusterInput[] = [];
    const slaveReader = new FakeClusterReader();
    const resolved = await makeClusterKubeResolver({
      db: db.db,
      master: { clusterReader: masterReader, argoReader: masterArgo, projectWriter: masterProjects },
      openCredential: (id) => store.open(id, { purpose: "test" }),
      buildClusterReader: (input): ClusterReader => {
        built.push(input);
        return slaveReader;
      },
    }).resolve(row.id);

    expect(resolved.clusterReader).toBe(slaveReader);
    expect(built).toEqual([{ server: written.kube.server, token: EMIT_ARGOCD_TOKEN, caData: written.kube.caData }]);
    expect(resolved.argoNamespace).toBe(written.argo.namespace);
  });
});
