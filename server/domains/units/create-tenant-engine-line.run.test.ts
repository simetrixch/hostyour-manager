// The engine line at create-tenant's PLAN: the tenant's bundle is built from the catalog, and every
// engine starts at its stage pin (create-tenant-registration.ts writes the pins as the tenant's
// versions), so the catalog's `engine` is held against those pins before anything is created
// (engine-line.ts). write-registration judges again with the pins as they stand when it writes, against
// the bundle release the run built. Kept apart from create-tenant.run.test.ts, which stands at the line
// budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { PlanStreamCtx, StepCtx } from "../../executor/types.ts";
import { writeRegistrationStep } from "./create-tenant-registration.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import { APP_OVERLAYS, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { TEMPLATE_APPS_YAML, TEMPLATE_SPEC, recordTestOwners, withAppsTemplate } from "./tenant-apps-repo.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);
const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: deploy
owner: platform
envs: [dev, prod]
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
${TEMPLATE_SPEC}`;
const DOCS: RenderedDoc[] = [
  { apiVersion: "v1", kind: "Namespace", name: "ns", namespace: "", raw: { kind: "Namespace" } },
  { apiVersion: "apps/v1", kind: "Deployment", name: "d", namespace: "x", raw: { kind: "Deployment" } },
];
const ENGINE_PIN = "0.3.004-stable-20260928080242-a1b2c3d";
const NEXT_LINE = "0.4.000-stable-20261001000000-abc1234";
const ENGINE_03 = 'engine:\n  build: example-engine\n  line: "0.3"\n';

let db: DbHandle;
beforeEach(() => {
  db = openUnitDb(); recordTestOwners(db.db);
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

/** A deploy repository whose engine chart is pinned at ENGINE_PIN, and a catalog whose apps.yaml carries `engine`. */
function ports(engine: string, books = new FakePlatformRepo()): TenantOnboardPorts {
  books.seed(books.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:\n  - { name: example-engine, image: example-engine, tag: "${ENGINE_PIN}" }\n`);
  return withAppsTemplate({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: DOCS } }),
    registrations: new TenantRegistrations(books),
    resolver: new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader({}), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git", platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git", argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: "global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: zot.m1.example\n" }],
    registryProbe: new FakeRegistryProbe(), buildRbac: new FakeBuildRbacWriter(), dns: new FakeDnsProvider(),
    channelStages: async () => TEST_CHANNEL_STAGES, attestedBuilds: async () => [], consumerHostLabels: async () => [],
  } as TenantOnboardPorts, { "apps.yaml": `${TEMPLATE_APPS_YAML}${engine}` });
}

const plan = (prt: TenantOnboardPorts, logs: string[] = []) =>
  makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", size: "small", apps: [{ name: "erp" }] }, { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal } satisfies PlanStreamCtx);

describe("create-tenant holds the catalog's engine line against the engine stage pin", () => {
  it("plans a tenant whose catalog bundle is written for the line its engines start on", async () => {
    expect((await plan(ports(ENGINE_03))).outcome).toBe("planned");
  });

  it("PLANTED DEFECT: rejects a tenant whose catalog bundle is written for another line than the engine stage pin", async () => {
    const result = await plan(ports('engine:\n  build: example-engine\n  line: "0.4"\n'));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toContain(`the apps bundle is written for example-engine 0.4, and erp would run example-engine ${ENGINE_PIN}, of another line`);
  });

  it("PLANTED DEFECT: write-registration judges the pins as it writes them, and registers no tenant off the bundle's line", async () => {
    const books = new FakePlatformRepo();
    const prt = ports(ENGINE_03, books);
    const result = await plan(prt);
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const p = result.params;
    // After the plan judged the pins, a build unit of the run pinned the engine on the next line.
    books.seed(books.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:\n  - { name: example-engine, image: example-engine, tag: "${NEXT_LINE}" }\n`);
    (prt.repo as FakeRepoReader).scriptFor(p.appsRepo!, { resolvedSha: SHA, files: { "apps.yaml": `${TEMPLATE_APPS_YAML}${ENGINE_03}` } });
    const step = writeRegistrationStep(prt, p, { appsImageTag: "0.3.002-stable-20260927000000-1234abc" });
    await expect(step.run({ log: () => undefined, signal: new AbortController().signal } as unknown as StepCtx))
      .rejects.toThrow(`tenant acme cannot start on these versions: the apps bundle is written for example-engine 0.3, and erp would run example-engine ${NEXT_LINE}, of another line`);
    expect((prt.repo as FakeRepoReader).clones.at(-1)).toMatchObject({ repoURL: p.appsRepo, ref: "0.3.002-stable-20260927000000" });
  });

  it("plans a catalog that declares no engine, and says the pairing is not checked", async () => {
    const logs: string[] = [];
    expect((await plan(ports(""), logs)).outcome).toBe("planned");
    expect(logs.some((l) => l.includes("declares no engine, so whether it fits the engine is not checked"))).toBe(true);
  });
});
