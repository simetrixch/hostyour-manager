// validateTenant with the app catalog (app-catalog.ts): the apps repository read through the
// catalog's or a registered unit's credential, the `{databases}` token filled from the manifest,
// the value files held against the checkout, and T4 judging the request by the manifest's words.
// Split from validate-tenant.test.ts so both files stay under the file-size doctrine.
import { describe, it, expect } from "vitest";
import { validateTenant, type ValidateTenantRequest, type ValidateTenantDeps } from "./validate-tenant.ts";
import { TENANT_MANIFEST_PATH, gateT4Apps } from "./gates/tenant-gates.ts";
import { resolveFanout, type AppRef } from "./tenant-fanout.ts";
import { TenantSpecSchema } from "../../../shared/consumer.ts";
import { APPS_MANIFEST_PATH, type AppsManifest } from "../../../shared/apps-manifest.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);
const PROBE = "zsjs023ctne0"; // a live-shaped throwaway guid
const REPO_OF_REQ = "https://github.com/acme/acme-catalog.git";

// The same fan-out manifest validate-tenant.test.ts validates against.
const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;
const SPEC = TenantSpecSchema.parse({
  members: [
    { name: "auth", chart: "charts/example-auth", identityProvider: true },
    { name: "jobs", chart: "charts/example-jobs" },
    { name: "report", chart: "charts/example-report" },
  ],
  perApp: { engine: { chart: "charts/example-engine" }, front: { chart: "charts/example-ui", override: { web: { chart: "charts/example-web" } } } },
});
/** A catalog the T4 gate tests hold apps against: erp offers the two seed selections, crm none. */
const CATALOG: AppsManifest = {
  apps: [
    { name: "erp", title: "ERP", description: "", selections: { seedReference: { title: "Reference data", default: true }, seedDemo: { title: "Demo data", default: false } } },
    { name: "crm", title: "CRM", description: "", selections: {} },
  ],
};
const NS_DOC: RenderedDoc = { apiVersion: "v1", kind: "Namespace", name: "namespace-x", namespace: "", raw: { kind: "Namespace" } };
const app = (name: string): AppRef => ({ name });
const CHAIN = [
  { path: "clusters/platform/values-prod.yaml", content: "global:\n  env: prod\n" },
  { path: clusterMapPath("m1.example"), content: "global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: zot.m1.example\n" },
];
function req(over: Partial<ValidateTenantRequest> = {}): ValidateTenantRequest {
  return { repoURL: REPO_OF_REQ, ref: "master", stage: "prod", apps: [app("erp")], probeGuid: PROBE, subdomain: "acme", clusterValueFiles: CHAIN, ...over };
}
function deps(repo: RepoReader, helm: FakeHelmRenderer, log: (l: string) => void = () => {}): ValidateTenantDeps {
  return { repo, helm, log, signal: new AbortController().signal, now: () => 1000 };
}

// ── gateT4Apps ───────────────────────────────────────────────────────────────────────────────────

describe("gateT4Apps", () => {
  const membersFor = (apps: AppRef[]) => resolveFanout(SPEC, apps, "prod");
  const renderedNames = (apps: AppRef[]) => membersFor(apps).map((m) => m.name);
  const STANDING = ["auth", "jobs", "report"];

  it("passes when every app is in the catalog and resolves to its rendered engine+front members", () => {
    const apps = [app("erp"), app("crm")];
    const g = gateT4Apps({ apps, members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: STANDING, catalog: CATALOG });
    expect(g.status).toBe("pass");
    expect(g.reason).toBeNull();
    expect(g.found).toMatch(/in the app catalog with declared selections only/);
  });

  it("rejects an app the catalog does not name, listing what it does", () => {
    const apps = [app("shop")];
    const g = gateT4Apps({ apps, members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: STANDING, catalog: CATALOG });
    expect(g.status).toBe("fail");
    expect(g.found).toBe(`app "shop" is not in the app catalog (erp, crm).`);
    expect(g.reason).toMatch(/no folder to mount/);
    // Counter-probe: the same request passes once the catalog names the app.
    expect(gateT4Apps({ apps, members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: STANDING, catalog: { apps: [...CATALOG.apps, { name: "shop", title: "Shop", description: "", selections: {} }] } }).status).toBe("pass");
  });

  it("rejects a selection the catalog does not declare for the app — a field set true, or any selections key", () => {
    const apps = [app("crm")];
    const base = { members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: STANDING, catalog: CATALOG };
    const fieldTrue = gateT4Apps({ ...base, apps: [{ name: "crm", seedReference: true }] });
    expect(fieldTrue.status).toBe("fail");
    expect(fieldTrue.found).toBe(`app "crm" chooses "seedReference", which the catalog does not declare for it (declared: none).`);
    const keyFalse = gateT4Apps({ ...base, apps: [{ name: "crm", selections: { seedPrices: false } }] });
    expect(keyFalse.status).toBe("fail");
    expect(keyFalse.found).toMatch(/chooses "seedPrices"/);
    // A field left false chooses nothing, and a declared selection passes whatever its value.
    expect(gateT4Apps({ ...base, apps: [{ name: "crm", seedReference: false, seedDemo: false, selections: {} }] }).status).toBe("pass");
    const erp = [app("erp")];
    expect(gateT4Apps({ apps: [{ name: "erp", seedReference: true, seedDemo: false }], members: membersFor(erp), renderedMembers: renderedNames(erp), standingMembers: STANDING, catalog: CATALOG }).status).toBe("pass");
  });

  it("rejects a reserved app name", () => {
    const apps = [app("erp")];
    // an apps[] entry named after a STANDING member of this tenant (the schema would also refuse it)
    const g = gateT4Apps({ apps: [{ name: "auth" }], members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: STANDING, catalog: { apps: [...CATALOG.apps, { name: "auth", title: "auth", description: "", selections: {} }] } });
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/standing member/);
  });

  it("rejects a duplicate app name", () => {
    const apps = [app("erp"), app("erp")];
    const g = gateT4Apps({ apps, members: membersFor([app("erp")]), renderedMembers: renderedNames([app("erp")]), standingMembers: STANDING, catalog: CATALOG });
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/more than once|collide/);
  });

  it("rejects an app whose member did not render", () => {
    const apps = [app("erp")];
    const g = gateT4Apps({ apps, members: membersFor(apps), renderedMembers: ["erp-1"], standingMembers: STANDING, catalog: CATALOG }); // the app's second render missing
    expect(g.status).toBe("fail");
    expect(g.found).toMatch(/erp-2/);
  });

  it("passes trivially with no apps, whatever the catalog holds", () => {
    expect(gateT4Apps({ apps: [], members: [], renderedMembers: [], standingMembers: STANDING, catalog: { apps: [] } }).status).toBe("pass");
  });
});

describe("validateTenant — the app catalog", () => {
  const APPS_REPO = "https://github.com/acme/acme-apps.git";
  /** The fixture manifest with an apps template (the bundle's name and its repository, built by no
   *  buildRepos entry), and a `{databases}` token where the product wants the app's database list. */
  const WITH_BUNDLE = MANIFEST_YAML.replace(
    "tenant:\n",
    `tenant:\n  appsBundle: acme-apps\n  appsRepo: ${APPS_REPO}\n`,
  ).replace(
    "    engine: { chart: charts/example-engine }",
    "    engine: { chart: charts/example-engine, valueFiles: [\"values-{app}.yaml\"], values: { databases: { mongodb: { databases: \"{databases}\" } } } }",
  );
  const APPS_YAML = `apps:\n  - name: erp\n    title: ERP\n    selections:\n      seedDemo: { title: Demo data }\n    databases: [core, logs]\n  - name: crm\n    title: CRM\n`;
  const filesOf = (helm: FakeHelmRenderer, member: string): string[] | undefined => helm.requests.find((r) => r.releaseName === `${PROBE}-${member}`)?.valueFiles;

  it("reads apps.yaml off the apps repository, fills {databases} for an app that declares a list, drops the key for one that does not, and layers only overlays that exist", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: WITH_BUNDLE, [APPS_MANIFEST_PATH]: APPS_YAML, "charts/example-engine/values-erp.yaml": "" } });
    const lines: string[] = [];
    const outcome = await validateTenant(req({ apps: [{ name: "erp", seedDemo: true }, app("crm")], credentialId: "cred_deploy" }), deps(repo, helm, (l) => lines.push(l)));
    expect(outcome.verdict).toBe("pass");
    // The template was cloned after the catalog, at its default branch head, with the catalog's
    // credential — the template is no unit, so no registration and no unit credential is asked for.
    expect(repo.clones).toEqual([{ repoURL: REPO_OF_REQ, ref: "master", credentialId: "cred_deploy" }, { repoURL: APPS_REPO, ref: "HEAD", credentialId: "cred_deploy" }]);
    // erp's engine: the list from the manifest, and its overlay, which stands; crm's engine: no
    // databases key at all (the token's key is gone) and no overlay (absent, and said).
    const erp = helm.requests.find((r) => r.releaseName === `${PROBE}-erp-1`);
    expect(erp?.valuesObject).toMatchObject({ databases: { mongodb: { databases: ["core", "logs"] } } });
    expect(filesOf(helm, "erp-1")).toEqual(["values.yaml", "values-prod.yaml", "values-erp.yaml"]);
    const crm = helm.requests.find((r) => r.releaseName === `${PROBE}-crm-1`);
    expect(crm?.valuesObject).not.toHaveProperty("databases");
    expect(filesOf(helm, "crm-1")).toEqual(["values.yaml", "values-prod.yaml"]);
    expect(lines.some((l) => l.includes("charts/example-engine/values-crm.yaml is absent in the catalog checkout — not layered on crm"))).toBe(true);
    // The registration records what was rendered: the resolved list, and only the file that stands.
    const erpRecord = outcome.memberRecords.find((m) => m.name === "erp");
    expect(erpRecord?.sources[0]).toEqual({ chart: "charts/example-engine", valueFiles: ["values-erp.yaml"], values: { databases: { mongodb: { databases: ["core", "logs"] } } } });
    expect(outcome.memberRecords.find((m) => m.name === "crm")?.sources[0]).toEqual({ chart: "charts/example-engine", valueFiles: [], values: {} });
    // The chosen selections ride to the charts as the appset delivers them.
    expect(erp?.valuesObject).toMatchObject({ tenant: { apps: [{ name: "erp", seedDemo: true }, { name: "crm" }] } });
  });

  it("T4 refuses an app the manifest does not name and a selection it does not declare, with the manifest's own words", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: WITH_BUNDLE, [APPS_MANIFEST_PATH]: APPS_YAML } });
    const unknownApp = await validateTenant(req({ apps: [app("shop")] }), deps(repo, helm));
    expect(unknownApp.verdict).toBe("fail");
    expect(unknownApp.report.gates.find((g) => g.id === "T4")?.found).toBe(`app "shop" is not in the app catalog (erp, crm).`);
    const unknownSelection = await validateTenant(req({ apps: [{ name: "erp", seedReference: true }] }), deps(repo, helm));
    expect(unknownSelection.verdict).toBe("fail");
    expect(unknownSelection.report.gates.find((g) => g.id === "T4")?.found).toMatch(/chooses "seedReference", which the catalog does not declare for it \(declared: seedDemo\)/);
  });

  it("falls back to the overlay stand-in where the template carries no apps.yaml, and says so in the log", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: WITH_BUNDLE, "charts/example-engine/values-erp.yaml": "" } });
    const lines: string[] = [];
    const outcome = await validateTenant(req({ apps: [{ name: "erp", seedReference: true }] }), deps(repo, helm, (l) => lines.push(l)));
    expect(outcome.verdict).toBe("pass"); // the stand-in offers the two seed selections
    expect(lines.some((l) => l.includes(`carries no ${APPS_MANIFEST_PATH}`) && l.includes("values-<app>.yaml overlays"))).toBe(true);
    // No list from a manifest, so the token's key is gone and the overlay decides.
    expect(helm.requests.find((r) => r.releaseName === `${PROBE}-erp-1`)?.valuesObject).not.toHaveProperty("databases");
  });

  it("a failing clone of the apps repository throws like a failing clone of the catalog (a preflight rejection)", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: WITH_BUNDLE } });
    const failing: RepoReader = {
      ...repo,
      cloneAtRef: async (input) => { if (input.repoURL === APPS_REPO) throw errValidation("clone failed: authentication required"); return repo.cloneAtRef(input); },
      readFile: (w, p) => repo.readFile(w, p), listDir: (w, p) => repo.listDir(w, p), dispose: (w) => repo.dispose(w),
    };
    await expect(validateTenant(req(), deps(failing, helm))).rejects.toThrow(/clone failed/);
  });
});
