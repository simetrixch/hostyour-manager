import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeSetSecretsDef, operatorKeys, type SetSecretsPorts } from "./set-secrets.run.ts";
import { FakeSeeder } from "./onboard.fixture.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";

// The one path that changes a declared secret of a standing consumer (#245): the manifest says which
// keys exist, the merge write carries only what the operator filled, and the two acts that make a
// value reach a pod — deleting the rendered Secret, rolling the workloads — ride the same run.

const REPO = "https://github.com/ahkutun/swissbookai.git";
const MANIFEST = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: swissbookai
owner: ahkutun
envs: [prod]
chart:
  path: deploy/chart
secrets:
  - key: JWT_ACCESS_SECRET
    description: minted by the platform
    required: true
    generate: hex32
  - key: SMTP_URL
    description: "SMTP URL of the customer's own mail account, e.g. smtp://user%40example.com:password@mail.example.com:587"
    required: true
  - key: S3_SESSION_TOKEN
    description: added to the manifest after the onboarding
    required: false
`;

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  // The owner of the repository records a repository PAT — a consumer is a foreign repository, and
  // its identity is its owner's (#226).
  seedCredentialRow(db.db, { id: "cred_pat_ahkutun", kind: "pat", label: "repository PAT (ahkutun)", subject: { kind: "owner", id: "ahkutun" }, purpose: "repository-pat" });
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "swissbookai", host: "swissbookai", stage: "prod", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ports(over: Partial<SetSecretsPorts> = {}, manifest: string | null = MANIFEST): SetSecretsPorts {
  const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
  return {
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
    seeder: new FakeSeeder(),
    github: { readFile: async () => manifest } as unknown as Pick<GitHubConsumer, "readFile">,
    store: { open: async () => Buffer.from("ghp_owner"), list: async () => [{ id: "cred_pat_ahkutun", kind: "pat", subject: { kind: "owner", id: "ahkutun" }, purpose: "repository-pat" }] } as unknown as CredentialStore,
    ...over,
  } as unknown as SetSecretsPorts;
}

function ctx(stepName: string, secrets: Record<string, string>, logs: string[]): StepCtx {
  return {
    runId: "run_sec", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: { appId: "app_1" },
    secrets: { get: (k: string) => (secrets[k] === undefined ? undefined : Buffer.from(secrets[k])), wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

async function runAll(steps: Step[], secrets: Record<string, string>, logs: string[]): Promise<void> {
  for (const step of steps) await step.run(ctx(step.name, secrets, logs));
}

describe("operatorKeys", () => {
  it("drops every key the Manager mints — the operator is asked for those at no point", () => {
    expect(operatorKeys([{ key: "A", required: true, generate: "hex32" }, { key: "B", required: true }]).map((s) => s.key)).toEqual(["B"]);
  });
});

describe("consumer-set-secrets", () => {
  it("offers every declared operator key of the manifest as read NOW, with its own sentence, all optional", async () => {
    const def = makeSetSecretsDef(ports());
    const planned = await def.planStream!({ appId: "app_1" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
    // S3_SESSION_TOKEN is in the manifest and not in the onboarding's frozen params: reading the
    // manifest is what makes a key added since the onboarding reachable at all.
    expect(planned.params.keys).toEqual(["SMTP_URL", "S3_SESSION_TOKEN"]);
    expect(planned.plan.requiredSecrets).toEqual([]);
    expect(planned.plan.optionalSecrets).toEqual(["consumer-secret:SMTP_URL", "consumer-secret:S3_SESSION_TOKEN"]);
    expect(planned.plan.secretHints?.["consumer-secret:SMTP_URL"]).toMatch(/smtp:\/\/user%40example\.com/);
    expect(planned.plan.steps.map((s) => s.name)).toEqual(["attest-target", "write-secrets", "refetch-secrets", "restart-workloads"]);
  });

  it("refuses where the repository carries no manifest, naming it", async () => {
    const def = makeSetSecretsDef(ports({}, null));
    const out = await def.planStream!({ appId: "app_1" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    expect(out.outcome).toBe("rejected");
    if (out.outcome !== "rejected") return;
    expect(out.summary).toMatch(/carries no deploy\/platform\.yaml/);
  });

  it("merges ONLY the keys that were filled, then deletes the rendered Secrets and rolls the workloads", async () => {
    const seeder = new FakeSeeder();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    cluster.setExternalSecrets("swissbookai-prod", [{ name: "swissbookai-es", ready: true, reason: "SecretSynced", targetSecret: "swissbookai-app", refreshTime: "" }]);
    const p = ports({ seeder, resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }) });
    const logs: string[] = [];
    await runAll(makeSetSecretsDef(p).steps({ appId: "app_1", keys: ["SMTP_URL", "S3_SESSION_TOKEN"] }), { "consumer-secret:SMTP_URL": "smtp://a:b@c:587", "consumer-secret:S3_SESSION_TOKEN": "" }, logs);
    // The blank box is not an answer: it keeps its stored value, so it is not in the patch.
    expect(seeder.patchedApps).toEqual([{ stage: "prod", consumerName: "swissbookai", data: { SMTP_URL: "smtp://a:b@c:587" } }]);
    expect(cluster.secretWrites).toEqual([{ op: "delete", namespace: "swissbookai-prod", name: "swissbookai-app" }]);
    expect(cluster.restarted.map((r) => r.namespace)).toEqual(["swissbookai-prod"]);
    expect(logs.some((l) => l.includes("SMTP_URL") && l.includes("untouched and was not read"))).toBe(true);
    expect(logs.some((l) => l.includes("smtp://a:b@c:587"))).toBe(false); // no value is ever logged
  });

  it("refuses a run in which every box was left empty, rather than patching an empty document", async () => {
    const seeder = new FakeSeeder();
    const steps = makeSetSecretsDef(ports({ seeder })).steps({ appId: "app_1", keys: ["SMTP_URL"] });
    await expect(steps[1]!.run(ctx("write-secrets", {}, []))).rejects.toThrow(/every box was left empty/);
    expect(seeder.patchedApps).toEqual([]);
  });

  it("says it plainly where the namespace renders no ExternalSecret — the new value then reaches no pod", async () => {
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const p = ports({ resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }) });
    const logs: string[] = [];
    await makeSetSecretsDef(p).steps({ appId: "app_1", keys: ["SMTP_URL"] })[2]!.run(ctx("refetch-secrets", {}, logs));
    expect(logs.some((l) => l.includes("holds no ExternalSecret"))).toBe(true);
  });
});
