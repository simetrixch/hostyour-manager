import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { CredentialStore } from "../../security/store.ts";
import { keepUnitCallKey } from "#unit/server/unit-call-key.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { StepCtx, Cleanup } from "../../executor/types.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { consumerUnitHost, tenantIssuerRecord, tenantMemberUrl, tenantZone } from "#unit/shared/unit-host.ts";
import { ConsumerRegistrationSchema, type TenantSpec } from "../../../shared/consumer.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import { createTestLogger, fakePost, KEPT } from "./tenant-sender-domain.fixture.ts";
import { createInstallationDomainIssuers, type InstallationDomainIssuerPorts } from "./installation-domain-issuers.ts";
import { readInstallationDomain, applyInstallationDomain, validateInstallationDomainRollback } from "./installation-domain.ts";

export const FROM = "old.example";
export const TO = "new.example";
export const OLD_HOST = `s1.${FROM}`;
export const NEW_HOST = `s1.${TO}`;
export const GUID = "zsjs023ctne0";
export const SENDER_DOMAIN = "customer.test";
export const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
export const ISSUERS_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/issuers";
export const MEMBERS = ["auth", "jobs", "report", "web"];

export function renderingZone(deployRepoUrl: string, guid: string, members: string[], stage: string, zone: string, ownDomain = ""): Map<string, ArgoAppStatus> {
  return new Map(members.map((m) => [`${guid}-${m}-${stage}`, {
    sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [{ repoURL: deployRepoUrl, revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: { zone, ownDomain } } }],
  } as ArgoAppStatus]));
}

export interface TestHarnessOptions {
  senderDomain?: string | undefined;
  keepKey?: boolean | undefined;
  hasIssuersRoute?: boolean | undefined;
  customSpec?: TenantSpec | null | undefined;
  renderedZone?: string | undefined;
  renderedOwnDomain?: string | undefined;
  lists?: Record<string, string[]> | undefined;
}

export async function makeIssuerTestHarness(opts: TestHarnessOptions = {}, handles: DbHandle[] = [], dirs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mgr-inst-domain-"));
  dirs.push(dir);
  const db = openDb(join(dir, "manager.db"));
  handles.push(db);

  const cloud = new FakePlatformRepo();
  const deploy = new FakePlatformRepo();
  const dns = new FakeDnsProvider();
  const consumers = new Registrations(cloud);
  const tenantRegistrations = new TenantRegistrations(deploy);
  const logger = createTestLogger();
  const store = new CredentialStore({ db: db.db, logger });

  const senderDomain = opts.senderDomain !== undefined ? opts.senderDomain : SENDER_DOMAIN;

  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: NEW_HOST, sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: NEW_HOST, name: "s1", status: "active" }).run();

  const mapPath = clusterMapPath(NEW_HOST);
  cloud.seed(cloud.booksBranch, mapPath, `global:\n  domain: ${NEW_HOST}\n  clusterName: s1\n  unitApex: ${FROM}\n  unrelated: keep\n`);

  const consumer = ConsumerRegistrationSchema.parse({
    name: "post", repoURL: "https://github.com/acme/post.git", chartPath: "deploy/chart", cluster: "s1", host: "post",
    databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: TEST_QUOTA,
  });
  cloud.seed(cloud.booksBranch, "registrations/post/prod.yaml", JSON.stringify(consumer));

  const tenantReg = {
    cluster: "s1", members: structuredClone(testMembers(["web"])), identityProvider: "auth",
    ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain, displayName: "", subdomain: "shop",
    apps: [{ name: "web", seedReference: false, seedDemo: false, selections: {} }], seedUsers: false, quota: TEST_QUOTA,
    resetNonce: "keep-data", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
  };
  const write = tenantRegistrationWrite("prod", GUID, tenantReg);
  deploy.seed(deploy.booksBranch, write.path, write.content);

  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "shop", stage: "prod",
    members: MEMBERS, identityProvider: "auth", senderDomain, ownDomain: "",
    ownDomainRedirects: [], status: "active",
  }).run();

  const unitHost = consumerUnitHost("post", "prod", FROM);
  const tenantHost = tenantZone("shop", "prod", FROM);
  const issuerName = tenantIssuerRecord("_idp", "auth", "prod", "shop", FROM).name;
  const issuer = tenantMemberUrl("auth", "prod", "shop", FROM, "");

  dns.seed(unitHost, "CNAME", OLD_HOST);
  recordDnsWrite(db.db, { name: unitHost, type: "CNAME", content: OLD_HOST, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_seed" });
  dns.seed(tenantHost, "CNAME", OLD_HOST);
  recordDnsWrite(db.db, { name: tenantHost, type: "CNAME", content: OLD_HOST, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_seed" });
  dns.seed(issuerName, "TXT", issuer, "unrelated-TXT");
  recordDnsWrite(db.db, { name: issuerName, type: "TXT", content: issuer, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_seed" });

  if (opts.keepKey !== false) {
    await keepUnitCallKey(store, { unit: "post", stage: "prod", key: "POST_MANAGER_KEY", value: KEPT });
  }

  const lists: Record<string, string[]> = opts.lists ?? (senderDomain ? { [senderDomain]: [tenantMemberUrl("auth", "prod", "shop", FROM, "")] } : {});
  const post = fakePost(lists);

  const defaultSpec: TenantSpec = {
    members: [{ name: "auth", chart: "charts/auth", identityProvider: true }],
    perApp: { engine: { chart: "charts/engine" }, front: { chart: "charts/front" } },
    buildRepos: [],
    libraryRepos: [],
    ...(opts.hasIssuersRoute !== false ? { senderDomainIssuers: { url: ISSUERS_ROUTE, unit: "post" } } : {}),
  };
  const spec = opts.customSpec !== undefined ? opts.customSpec : defaultSpec;
  const readTenantSpec = async () => spec;

  let currentRenderedZone = opts.renderedZone;
  let currentRenderedOwnDomain = opts.renderedOwnDomain ?? "";

  const argoReader = new FakeMasterArgoReader({
    statuses: currentRenderedZone ? renderingZone(DEPLOY_REPO, GUID, MEMBERS, "prod", currentRenderedZone, currentRenderedOwnDomain) : new Map(),
  });

  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: NEW_HOST, stage: "prod", writtenAt: "x", generation: 1 } }),
    argoReader,
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  });

  const issuerPorts: InstallationDomainIssuerPorts = { readTenantSpec, unitCall: post, resolver, deployRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000 };

  const issuers = createInstallationDomainIssuers(issuerPorts);

  const installationDomainPorts = {
    platformRepo: cloud,
    dns,
    consumers,
    tenantRegistrations,
    store,
    readTenantSpec,
  };

  const actions = {
    read: (inventory: Parameters<typeof readInstallationDomain>[0], from: string, to: string, signal?: AbortSignal) => readInstallationDomain(inventory, installationDomainPorts, from, to, signal),
    validateRollback: (ctx: StepCtx, snapshot: Parameters<typeof validateInstallationDomainRollback>[2], sourceRunId: string) => validateInstallationDomainRollback(ctx, installationDomainPorts, snapshot, sourceRunId),
    apply: (ctx: StepCtx, snapshot: Parameters<typeof applyInstallationDomain>[2], reverse: boolean, sourceRunId: string) => applyInstallationDomain(ctx, installationDomainPorts, snapshot, reverse, sourceRunId),
    ...issuers,
  };

  function setRenderedZone(zone: string, ownDomain = "") {
    currentRenderedZone = zone;
    currentRenderedOwnDomain = ownDomain;
    argoReader.setStatuses(renderingZone(DEPLOY_REPO, GUID, MEMBERS, "prod", zone, ownDomain));
  }

  function makeCtx(runId = "run_test", stepName = "test-step") {
    const logs: { stream: string; text: string }[] = [];
    const cleanups: Cleanup[] = [];
    const stepContext: StepCtx = {
      runId, stepName, db: db.db, params: {}, signal: new AbortController().signal,
      creds: store, logger, secrets: { get: () => undefined, wipe: () => undefined },
      ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")), closePasswordSession: () => undefined,
      attest: () => Promise.reject(new Error("no attest")),
      log: (stream, text) => { logs.push({ stream, text }); },
      checkpoint: () => undefined, readCheckpoint: () => undefined,
      registerCleanup: (c: Cleanup) => { cleanups.push(c); },
    };
    return { ctx: stepContext, logs, cleanups };
  }

  return {
    db, cloud, deploy, dns, store, post, lists, actions, issuerPorts, installationDomainPorts,
    tenantRegistrations, setRenderedZone, makeCtx, argoReader,
  };
}
