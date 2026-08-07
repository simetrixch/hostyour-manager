import { describe, it, expect } from "vitest";
import {
  validateTenant,
  type ValidateTenantRequest,
  type ValidateTenantDeps,
} from "./validate-tenant.ts";
import {
  TENANT_MANIFEST_PATH,
  gateT1Manifest,
  gateT2Render,
  gateT3Isolation,
  gateT4Apps,
  composeTenantReport,
  type MemberDocs,
  type MemberRender,
} from "./gates/tenant-gates.ts";
import { resolveFanout, type AppRef } from "./tenant-fanout.ts";
import { TenantSpecSchema } from "../../../shared/consumer.ts";
import { TenantValidationReportSchema } from "../../../shared/tenant.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { RenderedDoc, HelmRenderResult } from "../../adapters/helm/port.ts";
import type { GateResult } from "../../../shared/gates.ts";

const SHA = "a".repeat(40);
const PROBE = "zsjs023ctne0"; // a live-shaped throwaway guid

// A schema-valid catalog fan-out manifest: build-only (no chart) + a tenant: fan-out block.
// A tenant repo has NO chart, so the schema requires a non-empty builds[] — catalog is build-only.
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
    { name: "auth", chart: "charts/example-auth", identityProvider: true, namespaceLabels: { "platform/redis-consumer": "true" } },
    { name: "jobs", chart: "charts/example-jobs" },
    { name: "report", chart: "charts/example-report" },
  ],
  perApp: { engine: { chart: "charts/example-engine" }, front: { chart: "charts/example-ui", override: { web: { chart: "charts/example-web" } } } },
});

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${PROBE}`, raw: { kind }, ...over,
});
const NS_DOC = doc("Namespace", { namespace: "", raw: { kind: "Namespace" } });
const TENANT_DOC = doc("Tenant", { apiVersion: "operator.hostyour.cloud/v1", namespace: "", raw: { apiVersion: "operator.hostyour.cloud/v1", kind: "Tenant" } });
const app = (name: string): AppRef => ({ name });

/** The target cluster's chain as a plan hands it over — profile states the registry host the member
 *  charts require (example-lib.image), so a real render is possible with exactly this request. */
const CHAIN = [
  { path: "platform/values-prod.yaml", content: "global:\n  env: prod\n" },
  { path: "cluster/profile.yaml", content: "global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: zot.m1.example\n" },
];

function req(over: Partial<ValidateTenantRequest> = {}): ValidateTenantRequest {
  return { repoURL: "https://github.com/simetrixch/catalog.git", ref: "master", stage: "prod", apps: [app("erp")], probeGuid: PROBE, clusterValueFiles: CHAIN, ...over };
}

function deps(repo: RepoReader, helm: FakeHelmRenderer, log: (l: string) => void = () => {}): ValidateTenantDeps {
  return { repo, helm, log, signal: new AbortController().signal, now: () => 1000 };
}

function repoWithManifest(files: Record<string, string> = { [TENANT_MANIFEST_PATH]: MANIFEST_YAML }): FakeRepoReader {
  return new FakeRepoReader({ resolvedSha: SHA, files });
}

// ── gateT1Manifest ───────────────────────────────────────────────────────────────────────────────

describe("gateT1Manifest", () => {
  it("passes a valid ConsumerManifest that declares a tenant: block and returns the spec", () => {
    const t1 = gateT1Manifest(MANIFEST_YAML);
    expect(t1.result.status).toBe("pass");
    expect(t1.result.reason).toBeNull();
    expect(t1.manifest?.name).toBe("catalog");
    expect(t1.spec?.members.find((m) => m.name === "auth")?.chart).toBe("charts/example-auth");
  });

  it("fails closed when the manifest is absent", () => {
    const t1 = gateT1Manifest(null);
    expect(t1.result.status).toBe("fail");
    expect(t1.result.reason).not.toBeNull();
    expect(t1.spec).toBeNull();
    expect(t1.manifest).toBeNull();
  });

  it("fails on unparseable YAML", () => {
    const t1 = gateT1Manifest("apiVersion: :\n  - broken: [");
    expect(t1.result.status).toBe("fail");
    expect(t1.result.found).toMatch(/could not be parsed/);
  });

  it("fails schema validation with an issue summary", () => {
    const t1 = gateT1Manifest("apiVersion: hostyour.cloud/v1\nkind: ConsumerManifest\nname: X\n");
    expect(t1.result.status).toBe("fail");
    expect(t1.result.found).toMatch(/not a valid ConsumerManifest/);
  });

  it("rejects a valid manifest that declares NO tenant: block (not a fan-out repo)", () => {
    const noTenant = `apiVersion: hostyour.cloud/v1\nkind: ConsumerManifest\nname: acme\nowner: o\nenvs: [prod]\nchart: { path: deploy/chart }\n`;
    const t1 = gateT1Manifest(noTenant);
    expect(t1.result.status).toBe("fail");
    expect(t1.result.found).toMatch(/no tenant: fan-out block/);
    expect(t1.spec).toBeNull();
  });
});

// ── gateT2Render ─────────────────────────────────────────────────────────────────────────────────

describe("gateT2Render", () => {
  it("passes when every member rendered", () => {
    const renders: MemberRender[] = [
      { member: "auth", result: { ok: true, docs: [NS_DOC] } },
      { member: "jobs", result: { ok: true, docs: [] } },
    ];
    expect(gateT2Render(renders).status).toBe("pass");
  });

  it("fails on the first broken member and surfaces helm's error", () => {
    const renders: MemberRender[] = [
      { member: "auth", result: { ok: true, docs: [] } },
      { member: "erp-1", result: { ok: false, error: "helm template failed: boom" } },
    ];
    const g = gateT2Render(renders);
    expect(g.status).toBe("fail");
    expect(g.found).toMatch(/erp-1/);
    expect(g.found).toMatch(/boom/);
    expect(g.reason).not.toBeNull();
  });
});

// ── gateT3Isolation (the kind-scope fence) ───────────────────────────────────────────────────────

describe("gateT3Isolation", () => {
  const AUTH_NS = `${PROBE}-auth`; // the auth member's OWN namespace
  const ERP_NS = `${PROBE}-erp`; // the erp app member's OWN namespace (engine + front renders share it)
  const clean: MemberDocs[] = [
    { member: "auth", namespace: AUTH_NS, docs: [NS_DOC] },
    { member: "erp", namespace: ERP_NS, docs: [doc("Deployment"), doc("Service")] },
  ];

  it("passes when only Namespace appears at cluster scope and every member stays inside its own namespace", () => {
    const g = gateT3Isolation(clean);
    expect(g.status).toBe("pass");
    expect(g.reason).toBeNull();
    expect(g.id).toBe("T3");
  });

  it("rejects a forbidden cluster-scoped kind (ClusterRole)", () => {
    const g = gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [doc("ClusterRole")] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/cluster-scoped/);
    expect(g.evidence?.[0]?.kind).toBe("ClusterRole");
  });

  it("rejects the Tenant CR — the Controller is its sole writer, a chart-rendered twin would fight it", () => {
    const g = gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [TENANT_DOC] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/cluster-scoped/);
    expect(g.evidence?.[0]?.kind).toBe("Tenant");
  });

  it("rejects a self-minted ArgoCD Application", () => {
    const g = gateT3Isolation([{ member: "erp", namespace: ERP_NS, docs: [doc("Application")] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/argoproj\.io/);
  });

  it("rejects a Role/RoleBinding escalation", () => {
    expect(gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [doc("Role")] }]).status).toBe("fail");
    expect(gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [doc("RoleBinding")] }]).status).toBe("fail");
  });

  it("rejects an inline Secret", () => {
    const g = gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [doc("Secret")] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/Vault/);
  });

  it("rejects a namespaced object pinned to a namespace outside the fence entirely", () => {
    const escapee = doc("Deployment", { raw: { kind: "Deployment", metadata: { name: "d", namespace: "kube-system" } } });
    const g = gateT3Isolation([{ member: "erp", namespace: ERP_NS, docs: [escapee] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/namespace confinement|outside the member namespace/);
    expect(g.evidence?.[0]?.fieldPath).toBe("metadata.namespace");
  });

  it("rejects a document pinned to a SIBLING member's namespace — each member is fenced to its OWN namespace alone", () => {
    // erp's render pins a Deployment at the auth member's namespace instead of its own: just as much
    // an escape as a wholly foreign namespace, because T3 holds every member to ITS OWN namespace only.
    const crossMember = doc("Deployment", { raw: { kind: "Deployment", metadata: { name: "d", namespace: AUTH_NS } } });
    const g = gateT3Isolation([{ member: "erp", namespace: ERP_NS, docs: [crossMember] }]);
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/outside the member namespace/);
    expect(g.found).toContain(AUTH_NS);
  });

  it("catches a forbidden member smuggled inside a kind-agnostic List aggregate", () => {
    const smuggler = doc("Widget", {
      raw: { kind: "Widget", items: [{ kind: "ClusterRole", metadata: { name: "sneaky" } }] },
    });
    const g = gateT3Isolation([{ member: "auth", namespace: AUTH_NS, docs: [smuggler] }]);
    expect(g.status).toBe("fail");
    expect(g.evidence?.[0]?.kind).toBe("ClusterRole");
    expect(g.evidence?.[0]?.name).toBe("sneaky");
    expect(g.evidence?.[0]?.fieldPath).toMatch(/items\[0\]/);
  });
});

// ── gateT4Apps ───────────────────────────────────────────────────────────────────────────────────

describe("gateT4Apps", () => {
  const membersFor = (apps: AppRef[]) => resolveFanout(SPEC, apps, "prod");
  const renderedNames = (apps: AppRef[]) => membersFor(apps).map((m) => m.name);

  it("passes when every app resolves to its rendered engine+front members", () => {
    const apps = [app("erp"), app("crm")];
    const g = gateT4Apps({ apps, members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: ["auth", "jobs", "report"] });
    expect(g.status).toBe("pass");
    expect(g.reason).toBeNull();
  });

  it("rejects a reserved app name", () => {
    const apps = [app("erp")];
    // an apps[] entry named after a STANDING member of this tenant (the schema would also refuse it)
    const g = gateT4Apps({ apps: [{ name: "auth" }], members: membersFor(apps), renderedMembers: renderedNames(apps), standingMembers: ["auth", "jobs", "report"] });
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/standing member/);
  });

  it("rejects a duplicate app name", () => {
    const apps = [app("erp"), app("erp")];
    const g = gateT4Apps({ apps, members: membersFor([app("erp")]), renderedMembers: renderedNames([app("erp")]), standingMembers: ["auth", "jobs", "report"] });
    expect(g.status).toBe("fail");
    expect(g.reason).toMatch(/more than once|collide/);
  });

  it("rejects an app whose member did not render", () => {
    const apps = [app("erp")];
    const g = gateT4Apps({ apps, members: membersFor(apps), renderedMembers: ["erp-1"], standingMembers: ["auth", "jobs", "report"] }); // the app's second render missing
    expect(g.status).toBe("fail");
    expect(g.found).toMatch(/erp-2/);
  });

  it("passes trivially with no apps", () => {
    expect(gateT4Apps({ apps: [], members: [], renderedMembers: [], standingMembers: ["auth", "jobs", "report"] }).status).toBe("pass");
  });
});

// ── composeTenantReport ──────────────────────────────────────────────────────────────────────────

describe("composeTenantReport", () => {
  const hardPass: GateResult = { id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" };
  const hardFail: GateResult = { id: "T3", title: "isolation", severity: "hard", status: "fail", expected: "e", found: "f", reason: "r", detail: "d" };
  const meta = (gates: GateResult[]) => ({
    resolvedSha: SHA, probeGuid: PROBE, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report"],
    startedAt: 1, finishedAt: 2, manifest: null, gates,
  });

  it("passes only when every hard gate passed; chartsRef mirrors resolvedSha", () => {
    const r = composeTenantReport(meta([hardPass]));
    expect(r.verdict).toBe("pass");
    expect(r.chartsRef).toBe(SHA);
    expect(r.resolvedSha).toBe(SHA);
    expect(r.probeGuid).toBe(PROBE);
  });

  it("fails when any hard gate failed", () => {
    expect(composeTenantReport(meta([hardPass, hardFail])).verdict).toBe("fail");
  });

  it("produces a schema-valid report with a stable content hash", () => {
    const a = composeTenantReport(meta([hardPass]));
    const b = composeTenantReport(meta([hardPass]));
    expect(() => TenantValidationReportSchema.parse(a)).not.toThrow();
    expect(a.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.reportHash).toBe(b.reportHash); // deterministic over the canonical body
  });
});

// ── validateTenant (orchestration over the fakes) ────────────────────────────────────────────────

describe("validateTenant", () => {
  it("pass: clones catalog, renders every member at the probe guid INTO ITS OWN member namespace, and freezes a T1..T4+G9 report", async () => {
    const repo = repoWithManifest();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC, doc("Deployment")] } });
    const lines: string[] = [];
    const outcome = await validateTenant(req(), deps(repo, helm, (l) => lines.push(l)));

    expect(outcome.verdict).toBe("pass");
    expect(outcome.resolvedSha).toBe(SHA);
    expect(outcome.report.chartsRef).toBe(SHA);
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["T1", "T2", "T3", "T4", "G9"]);
    expect(outcome.report.appsValidated).toEqual(["erp"]);
    expect(outcome.report.resolvedMembers).toEqual(["auth", "jobs", "report", "erp-1", "erp-2"]);
    expect(outcome.report.manifest?.name).toBe("catalog");

    // each member rendered with the appset's release naming (<guid>-<render>) INTO ITS OWN member
    // namespace (<guid>-<member>): the trio each get their own namespace, while the app's engine and
    // front renders share the ONE namespace <guid>-erp — proving T3 has something real to fence.
    expect(helm.requests.map((r) => r.releaseName)).toEqual([
      `${PROBE}-auth`, `${PROBE}-jobs`, `${PROBE}-report`, `${PROBE}-erp-1`, `${PROBE}-erp-2`,
    ]);
    expect(helm.requests.map((r) => r.namespace)).toEqual([
      `${PROBE}-auth`, `${PROBE}-jobs`, `${PROBE}-report`, `${PROBE}-erp`, `${PROBE}-erp`,
    ]);
    expect(helm.requests.map((r) => r.chartPath)).toContain("charts/example-engine");
    // Every member is rendered WITH the target cluster's folded chain — the charts require values
    // from it (example-lib.image reads global.endpoints.registry.host), so a render without it would
    // fail T2 on every real install while the fakes kept passing.
    for (const r of helm.requests) {
      expect(r.valuesObject).toMatchObject({ global: { env: "prod", unitApex: "example.com", endpoints: { registry: { host: "zot.m1.example" } } } });
    }

    // gates + the clone streamed to the sink.
    expect(lines.some((l) => l.startsWith("T1 pass"))).toBe(true);
    expect(lines.some((l) => l.startsWith("G9 pass"))).toBe(true);
    expect(lines.some((l) => l.includes("cloned"))).toBe(true);
  });

  it("fail: an absent fan-out manifest yields verdict fail with only T1 + G9 and a null manifest", async () => {
    const repo = repoWithManifest({}); // no deploy/platform.yaml
    const helm = new FakeHelmRenderer();
    const outcome = await validateTenant(req(), deps(repo, helm));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.map((g) => g.id)).toEqual(["T1", "G9"]);
    expect(outcome.report.manifest).toBeNull();
    expect(outcome.report.resolvedMembers).toEqual([]);
    expect(helm.requests).toHaveLength(0); // nothing rendered without a spec
  });

  it("fail: a member that renders a forbidden cluster-scoped kind fails T3", async () => {
    const repo = repoWithManifest();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("ClusterRole")] } });
    const outcome = await validateTenant(req({ apps: [] }), deps(repo, helm));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "T3")?.status).toBe("fail");
  });

  it("fail: a broken render fails T2 and never composes a pass", async () => {
    const repo = repoWithManifest();
    const broken: HelmRenderResult = { ok: false, error: "helm template failed: missing dependency" };
    const helm = new FakeHelmRenderer({ fallback: broken });
    const outcome = await validateTenant(req({ apps: [] }), deps(repo, helm));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.report.gates.find((g) => g.id === "T2")?.status).toBe("fail");
  });

  it("is safe to call twice (the execute-time revalidate-at-pin re-runs against the same ref)", async () => {
    const repo = repoWithManifest();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    const first = await validateTenant(req({ apps: [] }), deps(repo, helm));
    const second = await validateTenant(req({ apps: [] }), deps(repo, helm));
    expect(first.report.reportHash).toBe(second.report.reportHash); // deterministic under now() injection
    expect(second.verdict).toBe("pass");
  });

  it("clone failure throws (the caller records it as a preflight rejection)", async () => {
    const throwingRepo: RepoReader = {
      cloneAtRef: async () => { throw errValidation("clone failed: authentication required"); },
      readFile: async () => null,
      listDir: async () => [],
      dispose: async () => {},
    };
    const helm = new FakeHelmRenderer();
    await expect(validateTenant(req(), deps(throwingRepo, helm))).rejects.toThrow(/clone failed/);
  });

  it("passes the credential to the clone (the controller's first-party catalog read credential)", async () => {
    const repo = repoWithManifest();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC] } });
    await validateTenant(req({ apps: [], credentialId: "cred_deploy" }), deps(repo, helm));
    expect(repo.clones[0]?.credentialId).toBe("cred_deploy");
  });
});
