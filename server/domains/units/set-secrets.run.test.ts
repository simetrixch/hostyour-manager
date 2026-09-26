import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeSetSecretsDef, operatorKeys, readSecretOffer, type SetSecretsPorts } from "./set-secrets.run.ts";
import { FakeSeeder } from "./onboard.fixture.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
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
  - key: DKIM_KEY_ENCRYPTION_KEY
    description: a generate key added to the manifest after the onboarding
    required: true
    generate: hex32
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
    await runAll(makeSetSecretsDef(p).steps({ appId: "app_1", keys: ["SMTP_URL", "S3_SESSION_TOKEN"], mint: [] }), { "consumer-secret:SMTP_URL": "smtp://a:b@c:587", "consumer-secret:S3_SESSION_TOKEN": "" }, logs);
    // The blank box is not an answer: it keeps its stored value, so it is not in the patch.
    expect(seeder.patchedApps).toEqual([{ stage: "prod", consumerName: "swissbookai", data: { SMTP_URL: "smtp://a:b@c:587" } }]);
    expect(cluster.secretWrites).toEqual([{ op: "delete", namespace: "swissbookai-prod", name: "swissbookai-app" }]);
    expect(cluster.restarted.map((r) => r.namespace)).toEqual(["swissbookai-prod"]);
    expect(logs.some((l) => l.includes("SMTP_URL") && l.includes("untouched and was not read"))).toBe(true);
    expect(logs.some((l) => l.includes("smtp://a:b@c:587"))).toBe(false); // no value is ever logged
  });

  it("refuses a run in which every box was left empty, rather than patching an empty document", async () => {
    const seeder = new FakeSeeder();
    const steps = makeSetSecretsDef(ports({ seeder })).steps({ appId: "app_1", keys: ["SMTP_URL"], mint: [] });
    await expect(steps[1]!.run(ctx("write-secrets", {}, []))).rejects.toThrow(/every box was left empty/);
    expect(seeder.patchedApps).toEqual([]);
  });

  it("offers the Secrets dialog the keys the operator fills and, apart, the generate keys with their kinds", async () => {
    expect(await readSecretOffer(ports(), db.db, "app_1")).toEqual({
      operatorKeys: [{ key: "SMTP_URL", description: expect.stringMatching(/^SMTP URL/) }, { key: "S3_SESSION_TOKEN", description: "added to the manifest after the onboarding" }],
      generateKeys: [{ key: "JWT_ACCESS_SECRET", kind: "hex32" }, { key: "DKIM_KEY_ENCRYPTION_KEY", kind: "hex32" }],
    });
  });

  describe("minting a generate key (#285)", () => {
    const plan = (mint: string[] | undefined, manifest = MANIFEST) =>
      makeSetSecretsDef(ports({}, manifest)).planStream!({ appId: "app_1", ...(mint ? { mint } : {}) }, { db: db.db, log: () => undefined, signal: new AbortController().signal });

    it("mints only the key the request names, in the one patch, and warns that it rotates a value the entry may hold", async () => {
      const planned = await plan(["DKIM_KEY_ENCRYPTION_KEY"]);
      if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
      expect(planned.params.mint.map((s) => s.key)).toEqual(["DKIM_KEY_ENCRYPTION_KEY"]);
      expect(planned.plan.warnings).toEqual([expect.stringMatching(/^DKIM_KEY_ENCRYPTION_KEY \(hex32\) is minted new\. Where prod\/consumer\/swissbookai\/app already holds DKIM_KEY_ENCRYPTION_KEY, this rotates it/)]);
      const seeder = new FakeSeeder();
      const logs: string[] = [];
      await makeSetSecretsDef(ports({ seeder })).steps(planned.params)[1]!.run(ctx("write-secrets", { "consumer-secret:SMTP_URL": "smtp://a:b@c:587" }, logs));
      const data = seeder.patchedApps[0]!.data;
      expect(Object.keys(data)).toEqual(["SMTP_URL", "DKIM_KEY_ENCRYPTION_KEY"]); // JWT_ACCESS_SECRET is not touched
      expect(data["DKIM_KEY_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
      expect(logs.some((l) => l.includes("minted new: DKIM_KEY_ENCRYPTION_KEY"))).toBe(true);
      expect(logs.some((l) => l.includes(data["DKIM_KEY_ENCRYPTION_KEY"]!))).toBe(false); // nothing minted is logged
    });

    it("mints no generate key where the request names none", async () => {
      const planned = await plan(undefined);
      if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
      expect(planned.params.mint).toEqual([]);
      expect(planned.plan.warnings).toEqual([]);
      const seeder = new FakeSeeder();
      await makeSetSecretsDef(ports({ seeder })).steps(planned.params)[1]!.run(ctx("write-secrets", { "consumer-secret:SMTP_URL": "smtp://a:b@c:587" }, []));
      expect(seeder.patchedApps.map((w) => Object.keys(w.data))).toEqual([["SMTP_URL"]]);
    });

    it("plans a request that only mints, for a manifest whose every key is minted too", async () => {
      const onlyGenerate = MANIFEST.replace(/ {2}- key: SMTP_URL[\s\S]*?(?= {2}- key: DKIM)/, "");
      const planned = await plan(["DKIM_KEY_ENCRYPTION_KEY"], onlyGenerate);
      if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
      expect(planned.params.keys).toEqual([]);
      const seeder = new FakeSeeder();
      await makeSetSecretsDef(ports({ seeder })).steps(planned.params)[1]!.run(ctx("write-secrets", {}, []));
      expect(seeder.patchedApps.map((w) => Object.keys(w.data))).toEqual([["DKIM_KEY_ENCRYPTION_KEY"]]);
      expect((await plan(undefined, onlyGenerate)).outcome).toBe("rejected"); // no operator key and no mint: nothing to change
    });

    it("refuses a name that is no generate key, a key derived from the repository PAT, half of a keypair, and the DKIM key", async () => {
      const refusal = async (mint: string[], manifest = MANIFEST): Promise<string> => {
        const out = await plan(mint, manifest);
        return out.outcome === "rejected" ? out.summary : "planned";
      };
      expect(await refusal(["SMTP_URL", "NOPE"])).toMatch(/declares no generate key SMTP_URL, NOPE — the keys it mints are JWT_ACCESS_SECRET, DKIM_KEY_ENCRYPTION_KEY$/);
      const more = `${MANIFEST}  - key: DEPLOY_GIT_CREDENTIALS\n    generate: deploy-git-credentials\n  - key: SIGN_KEY\n    generate: rsa2048\n  - key: SIGN_KEY_PUBLIC\n    generate: rsa2048-public\n    pairWith: SIGN_KEY\n`;
      expect(await refusal(["DEPLOY_GIT_CREDENTIALS"], more)).toMatch(/derived from the repository PAT/);
      expect(await refusal(["SIGN_KEY"], more)).toMatch(/SIGN_KEY and SIGN_KEY_PUBLIC are one keypair: mint both or neither/);
      expect(await refusal(["SIGN_KEY", "SIGN_KEY_PUBLIC"], more)).toBe("planned");
      // The SMTP entry's DKIM key: its public half stands in DNS from the onboarding's row.
      const mail = `${MANIFEST}  - key: MAIL_DKIM_PRIVATE_KEY
    generate: rsa2048
smtpEntry:
  service: acme-mta
  port: 2525
  dkimKey: MAIL_DKIM_PRIVATE_KEY
`;
      expect(await refusal(["MAIL_DKIM_PRIVATE_KEY"], mail)).toMatch(/MAIL_DKIM_PRIVATE_KEY is the DKIM key of its SMTP entry/);
      expect(await refusal(["DKIM_KEY_ENCRYPTION_KEY"], mail)).toBe("planned");
    });
  });

  it("says it plainly where the namespace renders no ExternalSecret — the new value then reaches no pod", async () => {
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const p = ports({ resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }) });
    const logs: string[] = [];
    await makeSetSecretsDef(p).steps({ appId: "app_1", keys: ["SMTP_URL"], mint: [] })[2]!.run(ctx("refetch-secrets", {}, logs));
    expect(logs.some((l) => l.includes("holds no ExternalSecret"))).toBe(true);
  });
});
