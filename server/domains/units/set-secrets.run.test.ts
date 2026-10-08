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
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";
import { consumerSecretEntry, listSecretWrites, recordSecretWrites } from "../../db/secret-writes.ts";
import { redact, unregisterScope } from "../../security/redact.ts";

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
afterEach(() => {
  unregisterScope("run_sec");
  db.sqlite.close();
});

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

  it("offers a key the installation's store holds as read-only, and plans no typed value for it", async () => {
    const withStore = `${MANIFEST}  - key: POST_OIDC_CLIENT_SECRET
    description: the identity provider's client secret of post
    required: true
    store: { entry: idp/clients/post, field: client-secret }
`;
    const planned = await makeSetSecretsDef(ports({}, withStore)).planStream!({ appId: "app_1" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
    expect(planned.params.keys).toEqual(["SMTP_URL", "S3_SESSION_TOKEN"]);
    const offered = (await readSecretOffer(ports({}, withStore), db.db, "app_1")).keys.find((k) => k.key === "POST_OIDC_CLIENT_SECRET");
    expect(offered).toMatchObject({ fromStore: "idp/clients/post:client-secret" });
    expect(offered?.kind).toBeUndefined();
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
    cluster.setExternalSecrets("swissbookai-prod", [{ name: "swissbookai-es", ready: true, reason: "SecretSynced", targetSecret: "swissbookai-app", refreshTime: "", remoteKeys: [] }]);
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

  it("offers every declared key with what the book of secret writes knows of it (#317)", async () => {
    const before = await readSecretOffer(ports(), db.db, "app_1");
    // Onboarded before the book: nothing is known of any key. The rows keep the manifest's order.
    expect(before.keys.map((k) => [k.key, k.kind ?? "operator", k.state])).toEqual([
      ["JWT_ACCESS_SECRET", "hex32", "unknown"], ["SMTP_URL", "operator", "unknown"], ["S3_SESSION_TOKEN", "operator", "unknown"], ["DKIM_KEY_ENCRYPTION_KEY", "hex32", "unknown"],
    ]);
    expect(before.keys[1]!.description).toMatch(/^SMTP URL/);
    // The book saw the onboarding write the entry: a key it did not write was never set since.
    recordSecretWrites(db.db, { entry: consumerSecretEntry("prod", "swissbookai"), keys: ["SMTP_URL", "JWT_ACCESS_SECRET", "DKIM_KEY_ENCRYPTION_KEY"], act: "seeded", runId: "run_onb" });
    const after = await readSecretOffer(ports(), db.db, "app_1");
    expect(after.keys.map((k) => [k.key, k.state])).toEqual([["JWT_ACCESS_SECRET", "set"], ["SMTP_URL", "set"], ["S3_SESSION_TOKEN", "never"], ["DKIM_KEY_ENCRYPTION_KEY", "set"]]);
    expect(after.keys[1]!.writtenAt).toEqual(expect.any(Number));
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
      expect(redact(`minted: ${data["DKIM_KEY_ENCRYPTION_KEY"]}`)).toBe("minted: •••");
      // The book: the typed key as set, the minted one as minted, never a value.
      const book = listSecretWrites(db.db, consumerSecretEntry("prod", "swissbookai")).map((w) => [w.key, w.act]).sort();
      expect(book).toEqual([["DKIM_KEY_ENCRYPTION_KEY", "minted"], ["SMTP_URL", "set"]]);
    });

    it("keeps a minted manager-key sealed under the stage, the same value the entry now holds", async () => {
      const withManagerKey = `${MANIFEST}  - key: POST_MANAGER_KEY
    description: the key the unit accepts from the Manager alone
    required: true
    generate: manager-key
`;
      const planned = await plan(["POST_MANAGER_KEY"], withManagerKey);
      if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
      const seeder = new FakeSeeder();
      const sealed: Array<{ plaintext: Buffer; subject: unknown; purpose: string }> = [];
      const creds = { list: async () => [], seal: async (input: { plaintext: Buffer; subject: unknown; purpose: string }) => { sealed.push(input); return { id: "cred_key" }; } } as unknown as CredentialStore;
      await makeSetSecretsDef(ports({ seeder }, withManagerKey)).steps(planned.params)[1]!.run({ ...ctx("write-secrets", {}, []), creds });
      const written = seeder.patchedApps[0]!.data["POST_MANAGER_KEY"];
      expect(written).toMatch(/^[0-9a-f]{64}$/);
      expect(sealed.map((x) => [x.plaintext.toString("utf8"), x.subject, x.purpose])).toEqual([[written, { kind: "unit-stage", id: "swissbookai-prod" }, "unit-call-key"]]);
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

  it("reads the manifest at deploy/<stage> — keys present on the delivery branch but removed at default head are offered and planned", async () => {
    db.db.insert(servers).values({ id: "srv_test", name: "m_test", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_test", serverId: "srv_test", stage: "test", domain: "test.example", name: "test", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_test", clusterId: "cls_test", name: "swissbookai-test", host: "swissbookai-test", stage: "test", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();

    const manifestDefault = MANIFEST;
    const manifestDelivery = `${MANIFEST}  - key: LEGACY_KEY\n    description: on deploy/test only\n    required: true\n`;

    const fakeGh = new FakeGitHubConsumer();
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", manifestDefault);
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", manifestDelivery, "deploy/test");

    const p = ports({ github: fakeGh });
    const offer = await readSecretOffer(p, db.db, "app_test");
    expect(offer.keys.map((k) => k.key)).toContain("LEGACY_KEY");

    const def = makeSetSecretsDef(p);
    const planned = await def.planStream!({ appId: "app_test" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
    expect(planned.params.keys).toContain("LEGACY_KEY");
  });

  it("falls back to default head when deploy/<stage> carries no manifest, noting it in offer and plan warnings", async () => {
    db.db.insert(servers).values({ id: "srv_test2", name: "m_test2", host: "1.2.3.6", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_test2", serverId: "srv_test2", stage: "test", domain: "test2.example", name: "test2", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_test2", clusterId: "cls_test2", name: "swissbookai-test2", host: "swissbookai-test2", stage: "test", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();

    const fakeGh = new FakeGitHubConsumer();
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", MANIFEST);
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", null, "deploy/test");

    const p = ports({ github: fakeGh });
    const offer = await readSecretOffer(p, db.db, "app_test2");
    expect(offer.note).toBe("there is no delivery branch deploy/test yet — the manifest was read at the default branch's head, which the first release delivers");

    const def = makeSetSecretsDef(p);
    const planned = await def.planStream!({ appId: "app_test2" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
    expect(planned.plan.warnings).toContain("there is no delivery branch deploy/test yet — the manifest was read at the default branch's head, which the first release delivers");
  });

  it("names a delivery branch that carries no manifest apart from a missing branch", async () => {
    db.db.insert(servers).values({ id: "srv_test3", name: "m_test3", host: "1.2.3.7", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_test3", serverId: "srv_test3", stage: "test", domain: "test3.example", name: "test3", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_test3", clusterId: "cls_test3", name: "swissbookai-test3", host: "swissbookai-test3", stage: "test", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();

    const fakeGh = new FakeGitHubConsumer();
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", MANIFEST);
    fakeGh.seedFile("ahkutun", "swissbookai", "deploy/platform.yaml", null, "deploy/test");
    fakeGh.seedBranch("ahkutun", "swissbookai", "deploy/test", { sha: "a".repeat(40), parents: [] });

    const p = ports({ github: fakeGh });
    const offer = await readSecretOffer(p, db.db, "app_test3");
    expect(offer.note).toBe("deploy/test carries no deploy/platform.yaml, because the release kit wrote none — the manifest was read at the default branch's head");

    const def = makeSetSecretsDef(p);
    const planned = await def.planStream!({ appId: "app_test3" }, { db: db.db, log: () => undefined, signal: new AbortController().signal });
    if (planned.outcome !== "planned") throw new Error(`refused: ${planned.summary}`);
    expect(planned.plan.warnings).toContain("deploy/test carries no deploy/platform.yaml, because the release kit wrote none — the manifest was read at the default branch's head");
  });
});
