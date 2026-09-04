import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerConsumerRoutes } from "./api.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { Registrations } from "./registrations.ts";
import type { SmokeResult, ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AppStatus, DriftVerdict } from "../../../shared/enums.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

// The per-consumer live reconciliation read (GET /api/consumers/:appId/live) — the SQL row is a TRACE
// of what the Manager BELIEVES; this reads the FACTS (a cluster smoke + the ArgoCD status) and
// compares what the Application PINS against what the cluster RUNS. The Manager's recorded SHA is no
// longer a compared revision — only the server-side fallback pin for a Missing Application (driftOf, the
// fallback the tests below still guard). Split into this sibling file next to api-tenant-live.test.ts
// (its tenant twin) because api.test.ts already sits past the 400-line budget.

const SHA = "a".repeat(40); // what the consumer's Application TARGETS
const DEPLOYED = "b".repeat(40); // where the pointer stands now / what the cluster runs
const GITOPS_SHA = "c".repeat(40); // the resolved head of the install branch
const CONSUMER_REPO = "https://github.com/x/acme.git";
// The generated consumer Application's OTHER two sources: the GitOps repo, targeted at the INSTALL
// BRANCH (hostyour-cloud clusters/argocd/files/consumers-appset.yaml carries `targetRevision:
// __BRANCH__`, and the chart at clusters/argocd/templates/apps.yaml fills that marker with the
// cluster map's global.domain, which is the branch named after the master FQDN). Reading a pin off
// source 0 therefore yields this NAME.
const GITOPS_REPO = "https://github.com/simetrixch/hostyour-cloud.git";
const INSTALL_BRANCH = "m1.example.com";

const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

// The master self-cluster cls_1 — the consumer row and the master-FQDN lookup both resolve off it.
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** The onboarded consumer `acme` on cls_1. The status is a parameter because it decides which
 *  lifecycle the row is in — only an ACTIVE pointer generates the consumer's ONE Application, so a
 *  suspended row is the case where an absent Application is the operator's own intended outcome. */
function seedConsumer(status: AppStatus = "active"): void {
  seedCluster();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: CONSUMER_REPO, status }).run();
}

const SMOKE_OK: SmokeResult = { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme", available: true, desired: 1, ready: 1 }], externalSecretsReady: true };

/** The THREE-source shape the generated consumer Application really has (measured on the master for
 *  example-auth / example-plane / example-post): the $values ref source and the image-guard source both
 *  point at the GitOps repo and target the install BRANCH, while the consumer's own chart sits in the
 *  MIDDLE at a 40-char SHA. `syncRevision` stays null on such an app — Argo reports one revision per
 *  source instead — so both halves of the comparison must be read per repoURL. */
function threeSourceApp(over: { targets: string; synced: string; sync?: "Synced" | "OutOfSync"; health?: "Healthy" | "Progressing" }): ArgoAppStatus {
  return {
    syncRevision: null,
    syncSources: [
      { repoURL: GITOPS_REPO, revision: GITOPS_SHA },
      { repoURL: CONSUMER_REPO, revision: over.synced },
      { repoURL: GITOPS_REPO, revision: GITOPS_SHA },
    ],
    targetRevision: null,
    targetSources: [
      { repoURL: GITOPS_REPO, targetRevision: INSTALL_BRANCH },
      { repoURL: CONSUMER_REPO, targetRevision: over.targets },
      { repoURL: GITOPS_REPO, targetRevision: INSTALL_BRANCH },
    ],
    sync: over.sync ?? "Synced",
    health: over.health ?? "Healthy",
  };
}

/** A live-read resolver whose (master) path yields a scripted smoke + ArgoCD status, so a test can
 *  drive the reconciliation endpoint's drift math without a cluster. */
function liveResolver(smoke: SmokeResult, argo: ArgoAppStatus | null): FakeClusterKubeResolver {
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ smoke }),
    argoReader: new FakeMasterArgoReader({ status: argo }),
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  });
}

/** A Registrations over a fake platform repo whose install branch states an apex that is NOT the cluster's
 *  domain — the shape every real cluster has, since install.sh defaults `unit-apex` to the cluster
 *  FQDN minus its first label. Without a registrations the route cannot read a chain at all, which is the
 *  null case every other test in this file exercises. */
function apexRegistrations(unitApex: string): Registrations {
  const repo = new FakePlatformRepo();
  repo.seed(repo.booksBranch, "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  repo.seed(repo.booksBranch, "clusters/platform/values-prod.yaml", "global:\n  env: prod\n");
  repo.seed(repo.booksBranch, clusterMapPath("s1.example"), `global:\n  unitApex: ${unitApex}\n`);
  return new Registrations(repo, async () => ({ name: "s1", stage: "prod" }));
}

async function makeConsumerLive(resolver?: FakeClusterKubeResolver, registrations?: Registrations): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  // The live route is a pure READ — no run defs are needed; the bare registrations satisfies the executor dep.
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerConsumerRoutes(a, { executor, db: db.db, store, onboardingEnabled: true, ...(resolver ? { resolver } : {}), ...(registrations ? { registrations } : {}) }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

interface LiveBody {
  unitHost: string | null;
  row: { name: string; domain: string; repoUrl?: string };
  cluster: { ok: boolean; namespaceExists: boolean; externalSecretsReady: boolean };
  argo: { ok: boolean; sync: string; health: string; syncRevision: string | null };
  drift: { pinned: string | null; deployed: string | null; verdict: DriftVerdict };
}
const live = async (app: Hono<AppEnv>, cookie: string): Promise<LiveBody> =>
  (await (await app.request("/api/consumers/app_1/live", authed(cookie))).json()) as LiveBody;

describe("the consumer's public address on the live payload", () => {
  it("is <name>.<unitApex> off the cluster's OWN values chain — not <name>.<clusterDomain>", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: SHA })), apexRegistrations("example.com"));
    const body = await live(app, cookie);
    // The cluster is reached at s1.example; the unit serves at the cluster's apex. The two differ
    // on every cluster whose FQDN carries a first label, which is the case this whole field exists for.
    expect(body.row.domain).toBe("s1.example");
    expect(body.unitHost).toBe("acme.example.com");
  });

  it("follows the apex the chain states, so a cluster that IS its own apex composes that instead", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: SHA })), apexRegistrations("s1.example"));
    expect((await live(app, cookie)).unitHost).toBe("acme.s1.example");
  });

  it("is null — no link at all — when no chain can be read, rather than a guessed host", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: SHA })));
    expect((await live(app, cookie)).unitHost).toBeNull();
  });
});

describe("consumer live reconciliation (GET /api/consumers/:appId/live)", () => {
  it("404 for an unknown consumer", async () => {
    seedCluster();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: SHA })));
    const res = await app.request("/api/consumers/app_missing/live", authed(cookie));
    expect(res.status).toBe(404);
  });

  it("degrades to SQL-only (reason) when onboarding is not configured (no resolver)", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(); // no resolver threaded
    const body = (await (await app.request("/api/consumers/app_1/live", authed(cookie))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ cluster: null, argo: null, drift: null, reason: "onboarding-not-configured" });
  });

  it("reads the cluster + argo and flags DRIFT when the deployed SHA != the pinned revision", async () => {
    seedConsumer();
    // The pointer still pins SHA (== the record) but the cluster is stuck on an older sync — the genuine
    // "the cluster has not caught up with the pointer" case the badge exists for.
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: DEPLOYED, sync: "OutOfSync", health: "Progressing" })));
    const body = await live(app, cookie);
    // Source (1): the SQL row TRACE is echoed — the private repoUrl is NOT leaked to the client.
    expect(body.row).toMatchObject({ name: "acme", domain: "s1.example" });
    expect(body.row.repoUrl).toBeUndefined();
    expect(body.cluster).toMatchObject({ ok: true, namespaceExists: true, externalSecretsReady: true });
    expect(body.argo).toMatchObject({ ok: true, sync: "OutOfSync", health: "Progressing", syncRevision: DEPLOYED });
    expect(body.drift).toEqual({ pinned: SHA, deployed: DEPLOYED, verdict: "drift" });
  });

  it("no drift when the deployed SHA matches the pinned revision", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: SHA })));
    expect((await live(app, cookie)).drift).toEqual({ pinned: SHA, deployed: SHA, verdict: "converged" });
  });

  // the state MEASURED on the master for example-auth and example-post. Their pointer
  // was advanced through GitOps (a commit on the install branch, not a Manager run), so the
  // Application targets DEPLOYED and ArgoCD converged onto it, while the Manager-side record only a
  // run ever advanced still said SHA. The card reads the pin off the Application (per repoURL, so it
  // gets the consumer chart's SHA and not source 0's branch name) and off nothing else — comparing
  // against that stale column is what painted both converged consumers "Drift".
  it("a pin moved through GitOps is IN SYNC — never 'drift'", async () => {
    seedConsumer();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: DEPLOYED, synced: DEPLOYED })));
    const body = await live(app, cookie);
    expect(body.argo).toMatchObject({ ok: true, sync: "Synced", health: "Healthy", syncRevision: DEPLOYED });
    // The pin is the consumer chart source's target — never INSTALL_BRANCH, which is what sources[0] targets.
    expect(body.drift).toEqual({ pinned: DEPLOYED, deployed: DEPLOYED, verdict: "converged" });
  });

  // There is no record to fall back on and no column that could hold one, so an ACTIVE consumer whose
  // Application is Missing has NOTHING pinned. The card says so — "not deployed", the neutral answer —
  // instead of promoting a Manager-side guess to a pin and calling the pair drift. The defect itself
  // is still reported, by the row above this one: argo health reads "Missing" on a consumer the operator
  // never suspended, which is the fact, and the verdict does not have to invent a revision to state it.
  it("an ACTIVE consumer whose Application is Missing has NOTHING pinned — health Missing carries the defect", async () => {
    seedConsumer(); // active: the pointer still asks for the Application, so an absent one is a defect
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, null)); // getApplication → null
    const body = await live(app, cookie);
    expect(body.argo).toMatchObject({ ok: true, health: "Missing", syncRevision: null });
    expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "not-deployed" });
  });

  // Here the operator ASKED for the absence. A consumer suspend git-mv's the pointer to suspended/ and its
  // run then WAITS for the Application to reach health Missing (suspend-resume.run.ts watch-prune) before
  // it records the row — so the missing Application is the success condition of a run the operator just
  // approved. Falling back to the record painted that as a degraded "drift" reading `pinned <sha> ·
  // deployed none`; meanwhile a suspended TENANT read "in sync", because its base Application survives a
  // suspend by design. The two cards answered the
  // same deliberate action oppositely. An offboarded consumer is the same fact for the same reason (the
  // pointer is git-rm'd, offboard.run.ts) — it keeps only its row.
  //
  // What such a consumer must NOT read is "converged". That is the FIX's other half and the test below is
  // its regression: no comparison happened here, so no verdict about one may be claimed.
  for (const status of ["suspended", "offboarded"] as const) {
    it(`a ${status} consumer's ABSENT Application is the intended outcome — never 'drift'`, async () => {
      seedConsumer(status);
      const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, null)); // getApplication → null
      const body = await live(app, cookie);
      expect(body.argo).toMatchObject({ ok: true, health: "Missing", syncRevision: null });
      // Nothing is pinned (the pointer no longer asks for the app) and nothing is deployed. The record is
      // still REPORTED — it is the last thing a Manager run wrote — but it is not promoted to a pin,
      // and with no pin to compare it against its own verdict stays UNKNOWN.
      expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "not-deployed" });
    });
  }

  // THE REGRESSION for a false green on a resume that died. This is byte-for-byte the same fixture as the
  // suspended case above — apps.status "suspended", no Application — because at this route the two states
  // are INDISTINGUISHABLE, and that is the entire point:
  //
  //   resume moves the GitOps pointer suspended/ -> active/ and COMMITS it in its second step
  //   (suspend-resume.run.ts resume-pointer), and writes the row only in its fourth (record-active, on
  //   success). Nothing rolls the pointer back. A resume that fails at watch-sync therefore leaves
  //   apps.status = "suspended" while the pointer STANDS IN active/ pinning a SHA — and the failure that
  //   produces it is exactly the one where no Application exists (watch-sync's message: health=Missing).
  //
  // Deciding the VERDICT from apps.status turns that consumer green: "in sync · pinned none · deployed
  // none" for a consumer that is pinned with nothing running — where the same state read as
  // "drift · pinned <sha> · deployed none" is correct. A false green on something broken is the
  // dangerous direction to be wrong in, and it is the same record-as-truth substitution the pin refuses.
  // "not-deployed" is TRUE of both readings, so the card asserts nothing it cannot support.
  it("a RESUME that died at watch-sync must not read green — the row says suspended, the pointer says otherwise", async () => {
    seedConsumer("suspended"); // what a failed resume leaves behind, identical to a finished suspend
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, null));
    const { drift } = await live(app, cookie);
    expect(drift.verdict).toBe("not-deployed");
    expect(drift.verdict).not.toBe("converged"); // the green claim, on a unit nothing was compared for
  });

  // The same false green by a second route, and the reason the verdict is derived from the RESOLVED
  // revisions rather than from the row's status: the row says "active" while nothing is pinned and
  // nothing runs. Nothing was compared there either, and "in sync" was equally unearned.
  it("an ACTIVE consumer with no Application reads 'not-deployed' by the row's status too — nothing was compared", async () => {
    seedCluster();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: CONSUMER_REPO, status: "active" }).run();
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, null));
    expect((await live(app, cookie)).drift).toEqual({ pinned: null, deployed: null, verdict: "not-deployed" });
  });

  it("a suspended consumer whose Application still STANDS is compared as usual — the carve-out is for an ABSENT app", async () => {
    // The carve-out must not become "a suspended consumer is never drifted". Between the pointer move and
    // ArgoCD's prune — or after a suspend run that failed at watch-prune, whose own message is "the pointer
    // is suspended but the workloads linger" — the Application is still there with a real spec, and then
    // its pin and its synced revision are exactly as comparable as an active consumer's.
    seedConsumer("suspended");
    const { app, cookie } = await makeConsumerLive(liveResolver(SMOKE_OK, threeSourceApp({ targets: SHA, synced: DEPLOYED, sync: "OutOfSync", health: "Progressing" })));
    expect((await live(app, cookie)).drift).toEqual({ pinned: SHA, deployed: DEPLOYED, verdict: "drift" });
  });

  it("an UNREADABLE ArgoCD is drift=UNKNOWN, never a false 'drift' badge", async () => {
    seedConsumer();
    const r = new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader({ smoke: SMOKE_OK }), argoReader: new FakeMasterArgoReader({ throwOnGet: new Error("argocd unreachable") }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" });
    const { app, cookie } = await makeConsumerLive(r); // getApplication REJECTS — the whole CR is unreadable
    const body = await live(app, cookie);
    // argo failed on its own row, but NEITHER verdict may claim a difference — UNKNOWN, not drifted/stale.
    // "unknown" and not "not-deployed": the revisions are not ABSENT here, they are unread, and the card
    // must say which of the two it is (shared/enums.ts DRIFT_VERDICT).
    expect(body.argo.ok).toBe(false);
    expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "unknown" });
  });
});
