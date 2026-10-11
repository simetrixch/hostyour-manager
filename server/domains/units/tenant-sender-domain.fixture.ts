// Test harness and fakes for tenant-set-sender-domain tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger, type Logger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetSenderDomainDef, type TenantSetSenderDomainPorts } from "./tenant-sender-domain.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { FakeUnitCall, type UnitCallRequest } from "#unit/server/adapters/unit-call/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { keepUnitCallKey } from "#unit/server/unit-call-key.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";

export const GUID = "zsjs023ctne0";
export const CLUSTER = "s1.example";
export const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
export const DOMAIN = "customer.test";
export const CHECK = "https://post.{stageApex}/api/public/sender-domains/{domain}";
export const ASKED = `https://post.example.com/api/public/sender-domains/${DOMAIN}`;
export const MEMBERS = ["auth", "jobs", "report"];
export const ISSUERS_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/issuers";
export const BOUND_AT = (domain: string): string => `https://post.example.com/api/internal/sender-domains/${domain}/issuers`;
export const ISSUER = "https://acme.example.com/auth";
export const OTHER_ISSUER = "https://shop.example.org/auth";
export const KEPT = "k".repeat(64);

export const DKIM_RECORD_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/dkim-record";
export const DKIM_CHECK_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/check";
export const DKIM_RECORD_URL = `https://post.example.com/api/internal/sender-domains/${DOMAIN}/dkim-record`;
export const DKIM_CHECK_URL = `https://post.example.com/api/internal/sender-domains/${DOMAIN}/check`;
const DMARC_RECORD_ROUTE = "https://post.{stageApex}/api/internal/sender-domains/{domain}/dmarc-record";
export const DMARC_RECORD_URL = `https://post.example.com/api/internal/sender-domains/${DOMAIN}/dmarc-record`;

export function createTestLogger(): Logger {
  return createLogger(parseConfig({
    ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv));
}

export const logger = createTestLogger();

export interface ManifestDkim {
  recordUrl: string;
  checkUrl: string;
  dmarcRecordUrl?: string;
  unit: string;
}

export const manifest = (check: string | null, issuers: boolean, dkim?: ManifestDkim | boolean, dmarc = false): string => {
  const dkimBlock = dkim === true
    ? `  senderDomainDkim: { recordUrl: "${DKIM_RECORD_ROUTE}", checkUrl: "${DKIM_CHECK_ROUTE}", ${dmarc ? `dmarcRecordUrl: "${DMARC_RECORD_ROUTE}", ` : ""}unit: post }\n`
    : dkim
      ? `  senderDomainDkim: { recordUrl: "${dkim.recordUrl}", checkUrl: "${dkim.checkUrl}", ${dkim.dmarcRecordUrl ? `dmarcRecordUrl: "${dkim.dmarcRecordUrl}", ` : ""}unit: ${dkim.unit} }\n`
      : "";
  return `apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-deploy
owner: platform
envs: [prod]
tenant:
  members:
    - { name: auth, path: /auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, path: /jobs, chart: charts/example-jobs }
    - { name: report, path: /reports, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
  buildRepos: []
${check ? `  senderDomainCheck: ${check}\n` : ""}${issuers ? `  senderDomainIssuers: { url: "${ISSUERS_ROUTE}", unit: post }\n` : ""}${dkimBlock}`;
};

export const DKIM_RECORD_NAME = `sel._domainkey.${DOMAIN}`;
export const DKIM_RECORD_CONTENT = "v=DKIM1; p=MIGfMA0GCSqGSIb3DQE";
export const DKIM_ZONE = "customer.test";
export const DMARC_RECORD_NAME = `_dmarc.${DOMAIN}`;
// Not the policy post starts a domain with, so a Manager that wrote a policy of its own would show.
export const DMARC_RECORD_CONTENT = "v=DMARC1; p=quarantine; pct=50";

export interface FakePostOptions {
  lists?: Record<string, string[]> | undefined;
  status?: number[] | undefined;
  dkimRecord?: { name?: unknown; type?: unknown; content?: unknown } | null | undefined;
  dmarcRecord?: { name?: unknown; type?: unknown; content?: unknown } | null | undefined;
  onCheck?: ((domain: string) => void) | undefined;
  checkStatus?: number | undefined;
}

/** post's issuer lists and DKIM endpoints per sender domain, answering the Manager's routes as post
 *  does: only with the kept key. */
export function fakePost(
  listsOrOpts: Record<string, string[]> | FakePostOptions = {},
  status?: number[],
): FakeUnitCall {
  const isOpts = typeof listsOrOpts === "object" && listsOrOpts !== null &&
    ("lists" in listsOrOpts || "dkimRecord" in listsOrOpts || "dmarcRecord" in listsOrOpts || "onCheck" in listsOrOpts || "checkStatus" in listsOrOpts);
  const opts: FakePostOptions = isOpts ? (listsOrOpts as FakePostOptions) : { lists: listsOrOpts as Record<string, string[]>, status };
  const lists = opts.lists ?? {};
  const forcedStatus = opts.status ? [...opts.status] : [];
  return new FakeUnitCall((req: UnitCallRequest) => {
    const forced = forcedStatus.shift();
    if (forced !== undefined) return { status: forced, detail: `HTTP ${forced}` };
    if (req.key !== KEPT) return { status: 401, detail: "HTTP 401" };
    const domain = decodeURIComponent(req.url.split("/sender-domains/")[1]!.split("/")[0]!);
    if (req.url.endsWith("/dkim-record")) {
      if (opts.dkimRecord === null) return { status: 404, detail: "HTTP 404" };
      return {
        status: 200,
        detail: "HTTP 200",
        body: opts.dkimRecord ?? { name: `sel._domainkey.${domain}`, type: "TXT", content: DKIM_RECORD_CONTENT },
      };
    }
    if (req.url.endsWith("/dmarc-record")) {
      if (opts.dmarcRecord === null) return { status: 404, detail: "HTTP 404" };
      return {
        status: 200,
        detail: "HTTP 200",
        body: opts.dmarcRecord ?? { name: `_dmarc.${domain}`, type: "TXT", content: DMARC_RECORD_CONTENT },
      };
    }
    if (req.url.endsWith("/check")) {
      opts.onCheck?.(domain);
      const s = opts.checkStatus ?? 200;
      return { status: s, detail: `HTTP ${s}`, body: { checked: true } };
    }
    const issuer = (req.body as { issuer: string } | undefined)?.issuer ?? "";
    const list = lists[domain] ?? [];
    const had = list.includes(issuer);
    lists[domain] = req.method === "PUT" ? (had ? list : [...list, issuer]) : list.filter((i) => i !== issuer);
    return { status: 200, detail: "HTTP 200", body: req.method === "PUT" ? { added: !had } : { removed: had } };
  });
}

/** Every member Synced + Healthy, each chart rendering `domain` as tenant.senderDomain. */
export function rendering(domain: string): Map<string, ArgoAppStatus> {
  return new Map(MEMBERS.map((m) => [`${GUID}-${m}-prod`, {
    sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [{ repoURL: DEPLOY_REPO, revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: { senderDomain: domain } } }],
  } as ArgoAppStatus]));
}

export interface MakeOptions {
  senderDomain?: string;
  renders?: string;
  answer?: { status: number; body?: string };
  check?: string | null;
  suspended?: boolean;
  issuers?: boolean;
  kept?: boolean;
  post?: FakeUnitCall;
  dns?: FakeDnsProvider;
  dkim?: ManifestDkim | boolean;
  /** The default DKIM routes plus the DMARC record route beside them. */
  dmarc?: boolean;
  dkimWaitMs?: number;
  dkimPollMs?: number;
}

export async function make(opts: MakeOptions = {}, handles: DbHandle[] = [], dirs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mgr-senderdomain-"));
  dirs.push(dir);
  const db = openDb(join(dir, "manager.db"));
  handles.push(db);
  const senderDomain = opts.senderDomain ?? "";
  const reg = new TenantRegistrations(new FakePlatformRepo());
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
    members: MEMBERS, identityProvider: "auth", senderDomain, suspended: opts.suspended ?? false, status: "active",
  }).run();
  await reg.commitTenant({
    stage: "prod", guid: GUID, runId: "run_crt",
    registration: {
      cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain, displayName: "",
      seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
    },
  });
  const dkim = opts.dkim ?? opts.dmarc;
  const creds = new CredentialStore({ db: db.db, logger });
  if (opts.kept ?? (opts.issuers || dkim)) await keepUnitCallKey(creds, { unit: "post", stage: "prod", key: "POST_MANAGER_KEY", value: KEPT });
  const post = opts.post ?? fakePost({});
  const dns = opts.dns ?? new FakeDnsProvider();
  const probe = new FakePublicProbe();
  const answer = opts.answer ?? { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) };
  probe.set(ASKED, { reachable: answer.status < 500 && answer.status !== 404, status: answer.status, detail: `HTTP ${answer.status}`, ...(answer.body !== undefined ? { body: answer.body } : {}) });
  const def = makeTenantSetSenderDomainDef({
    registrations: reg,
    repo: new FakeRepoReader({ resolvedSha: "a".repeat(40), files: { "deploy/platform.yaml": manifest(opts.check === undefined ? CHECK : opts.check, opts.issuers ?? false, dkim, opts.dmarc ?? false) } }),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: new FakeMasterArgoReader({ statuses: rendering(opts.renders ?? senderDomain) }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    deployRepoUrl: DEPLOY_REPO, argoWatchTimeoutMs: 1000, probe, unitCall: post, store: creds, dns,
    resolveClusterValueFiles: async () => [{ path: "clusters/s1.yaml", content: "global:\n  unitApex: example.com\n" }],
    ...(opts.dkimWaitMs !== undefined ? { dkimWaitMs: opts.dkimWaitMs } : {}),
    ...(opts.dkimPollMs !== undefined ? { dkimPollMs: opts.dkimPollMs } : {}),
  } as unknown as TenantSetSenderDomainPorts);
  const executor = new Executor({
    db: db.db, creds, bus: new RunEventBus(), logger,
    runDefinitions: new Map([["tenant-set-sender-domain", def as unknown as AnyRunDefinition]]),
    sshFactory: () => Promise.reject(new Error("no ssh")),
  });
  const row = () => db.db.select({ d: tenants.senderDomain }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.d;
  const registered = async () => (await reg.readTenant("prod", GUID))?.entry.senderDomain;
  return { db, executor, probe, row, registered, reg, post, dns, creds, def };
}

export async function set(h: Awaited<ReturnType<typeof make>>, senderDomain: string, previous = ""): Promise<string> {
  const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain, previous });
  await h.executor.approve(runId);
  await h.executor.settle(runId);
  return runId;
}
