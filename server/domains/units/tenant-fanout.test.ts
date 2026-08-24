import { describe, it, expect } from "vitest";
import {
  memberAppProject,
  memberApplication,
  memberNamespace,
  resolveFanout,
  resolveMembers,
  tenantApplicationSet,
  tenantNamespaces,
  type AppRef,
  type FanoutMember,
} from "./tenant-fanout.ts";
import { TenantSpecSchema, type TenantSpec } from "../../../shared/consumer.ts";

/** The standing members the product under test declares, and the members a tenant of it ends up with
 *  once its apps are added. Stated by the fixture, the way a real tenant's registration states its own
 *  — the platform holds no such list. */
const STANDING = ["auth", "jobs", "report"];
const membersOf = (...apps: string[]): string[] => [...STANDING, ...apps];

// A tenant product's fan-out block, parsed through the real schema so the fixture stays honest against
// the contract. `{app}` appears where the product's own file and resource names carry the app name.
const SPEC: TenantSpec = TenantSpecSchema.parse({
  members: [
    { name: "auth", chart: "charts/example-auth", identityProvider: true, namespaceLabels: { "platform/redis-consumer": "true" } },
    { name: "jobs", chart: "charts/example-jobs" },
    { name: "report", chart: "charts/example-report" },
  ],
  perApp: {
    engine: {
      chart: "charts/example-engine",
      valueFiles: ["values-{app}.yaml"],
      values: { fullnameOverride: "example-engine-{app}" },
    },
    front: {
      chart: "charts/example-ui",
      values: { fullnameOverride: "example-ui-{app}", ingress: { engineService: "example-engine-{app}" } },
      override: { web: { chart: "charts/example-web", values: { fullnameOverride: "example-web" } } },
    },
  },
});

const GUID = "zsjs023ctne0"; // a live tenant guid
const app = (name: string): AppRef => ({ name });
const names = (apps: readonly AppRef[], stage: "dev" | "test" | "prod" = "dev"): string[] =>
  resolveFanout(SPEC, apps, stage).map((m) => m.name);

/** The ONE Application a render belongs to: <guid>-<member>-<stage>. The two renders of an app carry
 *  the same member, so both map to the same Application. */
const appOf = (m: FanoutMember, stage: "dev" | "test" | "prod"): string => memberApplication(GUID, m.member, stage);

describe("the per-member naming — one namespace and one AppProject per member", () => {
  it("names a member namespace <guid>-<member>, never the bare guid", () => {
    expect(memberNamespace(GUID, "auth")).toBe("zsjs023ctne0-auth");
    expect(memberNamespace(GUID, "erp")).toBe("zsjs023ctne0-erp");
    expect(tenantNamespaces(membersOf("erp"), GUID)).not.toContain(GUID);
  });

  it("holds the identity law per member: AppProject name == namespace", () => {
    for (const member of membersOf("erp", "web")) {
      expect(memberAppProject(GUID, member)).toBe(memberNamespace(GUID, member));
    }
  });

  it("gives a tenant with several members one namespace and one AppProject EACH, pairwise different", () => {
    const members = membersOf("erp", "crm", "web");
    const namespaces = tenantNamespaces(members, GUID);
    expect(namespaces).toEqual([
      "zsjs023ctne0-auth",
      "zsjs023ctne0-jobs",
      "zsjs023ctne0-report",
      "zsjs023ctne0-erp",
      "zsjs023ctne0-crm",
      "zsjs023ctne0-web",
    ]);
    expect(new Set(namespaces).size).toBe(namespaces.length); // pairwise different
    for (const ns of namespaces) expect(ns.startsWith(`${GUID}-`)).toBe(true);
    // The AppProjects are the same six strings — one per member, never one shared project.
    expect(members.map((m) => memberAppProject(GUID, m))).toEqual(namespaces);
  });

  it("leaves every OTHER member standing when one member is torn down", () => {
    const before = tenantNamespaces(membersOf("erp", "crm"), GUID);
    const after = tenantNamespaces(membersOf("crm"), GUID); // erp removed
    expect(after).not.toContain(memberNamespace(GUID, "erp"));
    for (const ns of after) expect(before).toContain(ns);
    expect(after).toEqual(["zsjs023ctne0-auth", "zsjs023ctne0-jobs", "zsjs023ctne0-report", "zsjs023ctne0-crm"]);
  });

  it("addresses no member the product did not declare — the bracket is its members and its apps", () => {
    expect(membersOf("erp")).not.toContain("base");
    expect(tenantNamespaces(membersOf("erp"), GUID)).not.toContain(`${GUID}-base`);
    expect(tenantApplicationSet(membersOf("erp"), GUID, "dev")).not.toContain(`${GUID}-base-dev`);
    expect(names([app("erp")])).not.toContain("base");
  });
});

describe("resolveMembers — the ONE resolution the registration records and the appset renders", () => {
  it("emits every standing member the product declares, verbatim, for a tenant with no apps", () => {
    const m = resolveMembers(SPEC, []);
    expect(m.map((x) => x.name)).toEqual(["auth", "jobs", "report"]);
    expect(m.map((x) => x.sources.map((s) => s.chart))).toEqual([
      ["charts/example-auth"],
      ["charts/example-jobs"],
      ["charts/example-report"],
    ]);
    // A standing member declares ONE chart, so it renders one source.
    for (const x of m) expect(x.sources).toHaveLength(1);
  });

  it("carries a standing member's own namespaceLabels through, and gives the others an empty map", () => {
    const m = resolveMembers(SPEC, [app("erp")]);
    expect(m.find((x) => x.name === "auth")?.namespaceLabels).toEqual({ "platform/redis-consumer": "true" });
    expect(m.find((x) => x.name === "jobs")?.namespaceLabels).toEqual({});
    // Written, never omitted: the appset reads it bare under missingkey=error.
    for (const x of m) expect(x.namespaceLabels).toBeDefined();
  });

  it("adds ONE member per app, after the standing ones, in apps[] order", () => {
    expect(resolveMembers(SPEC, [app("erp"), app("crm")]).map((x) => x.name)).toEqual([
      "auth", "jobs", "report", "erp", "crm",
    ]);
  });

  it("builds an app member from perApp — engine first, then front — into its ONE namespace", () => {
    const erp = resolveMembers(SPEC, [app("erp")]).find((x) => x.name === "erp")!;
    expect(erp.sources.map((s) => s.chart)).toEqual(["charts/example-engine", "charts/example-ui"]);
    expect(memberNamespace(GUID, erp.name)).toBe("zsjs023ctne0-erp");
  });

  it("substitutes {app} in the value files and in every string of the values", () => {
    const erp = resolveMembers(SPEC, [app("erp")]).find((x) => x.name === "erp")!;
    expect(erp.sources[0]!.valueFiles).toEqual(["values-erp.yaml"]);
    expect(erp.sources[0]!.values).toEqual({ fullnameOverride: "example-engine-erp" });
    // At any depth, not just the top level.
    expect(erp.sources[1]!.values).toEqual({
      fullnameOverride: "example-ui-erp",
      ingress: { engineService: "example-engine-erp" },
    });
  });

  it("leaves a standing member's strings alone — it has no app to substitute", () => {
    const withToken = TenantSpecSchema.parse({
      members: [{ name: "idp", chart: "charts/x", identityProvider: true, values: { note: "literal {app}" } }],
      perApp: { engine: { chart: "charts/e" }, front: { chart: "charts/f" } },
    });
    expect(resolveMembers(withToken, []).find((x) => x.name === "idp")!.sources[0]!.values).toEqual({ note: "literal {app}" });
  });

  it("swaps the WHOLE front source for an app the product's override map names", () => {
    const web = resolveMembers(SPEC, [app("web")]).find((x) => x.name === "web")!;
    expect(web.sources[1]!.chart).toBe("charts/example-web");
    expect(web.sources[1]!.values).toEqual({ fullnameOverride: "example-web" });
    // The keyed lookup IS the selection: an app the map does not name keeps the default.
    const erp = resolveMembers(SPEC, [app("erp")]).find((x) => x.name === "erp")!;
    expect(erp.sources[1]!.chart).toBe("charts/example-ui");
  });

  it("writes valueFiles and values on EVERY source, so the appset may read them bare", () => {
    for (const m of resolveMembers(SPEC, [app("erp"), app("web")])) {
      for (const s of m.sources) {
        expect(Array.isArray(s.valueFiles)).toBe(true);
        expect(typeof s.values).toBe("object");
      }
    }
  });
});

describe("resolveFanout — the flattening the validator renders", () => {
  it("renders each standing member exactly once, never per app", () => {
    const m = resolveFanout(SPEC, [app("erp"), app("crm")], "dev");
    for (const member of STANDING) {
      expect(m.filter((x) => x.member === member)).toHaveLength(1);
    }
  });

  it("puts each standing render in its OWN member namespace", () => {
    expect(resolveFanout(SPEC, [], "dev").map((m) => memberNamespace(GUID, m.member))).toEqual([
      "zsjs023ctne0-auth",
      "zsjs023ctne0-jobs",
      "zsjs023ctne0-report",
    ]);
  });

  it("names a one-source member by its member name and a multi-source member per source", () => {
    expect(names([app("erp"), app("crm")])).toEqual([
      "auth", "jobs", "report",
      "erp-1", "erp-2",
      "crm-1", "crm-2",
    ]);
  });

  it("gives an app's two renders the SAME member, so both land in the one namespace", () => {
    const perApp = resolveFanout(SPEC, [app("erp")], "dev").filter((x) => x.member === "erp");
    expect(perApp).toHaveLength(2);
    expect(new Set(perApp.map((x) => memberNamespace(GUID, x.member)))).toEqual(new Set(["zsjs023ctne0-erp"]));
    expect(new Set(perApp.map((x) => appOf(x, "dev")))).toEqual(new Set(["zsjs023ctne0-erp-dev"]));
  });

  it("layers values.yaml + values-<stage>.yaml on every render, the source's own files after", () => {
    for (const m of resolveFanout(SPEC, [app("erp")], "prod")) {
      expect(m.valueFiles.slice(0, 2)).toEqual(["values.yaml", "values-prod.yaml"]);
    }
    const m = resolveFanout(SPEC, [app("erp")], "test").filter((x) => x.member === "erp");
    expect(m[0]!.valueFiles).toEqual(["values.yaml", "values-test.yaml", "values-erp.yaml"]);
    expect(m[1]!.valueFiles).toEqual(["values.yaml", "values-test.yaml"]);
  });
});

describe("tenantApplicationSet — expected Application names (match the tenant appset)", () => {
  it("is the standing members alone for a tenant with no apps", () => {
    expect(tenantApplicationSet(STANDING, GUID, "dev")).toEqual([
      "zsjs023ctne0-auth-dev",
      "zsjs023ctne0-jobs-dev",
      "zsjs023ctne0-report-dev",
    ]);
  });

  it("carries the stage suffix on every name", () => {
    expect(tenantApplicationSet(membersOf("erp"), GUID, "prod")).toEqual([
      "zsjs023ctne0-auth-prod",
      "zsjs023ctne0-jobs-prod",
      "zsjs023ctne0-report-prod",
      "zsjs023ctne0-erp-prod",
    ]);
  });

  it("produces ONE Application per app, whatever the app renders inside it", () => {
    expect(tenantApplicationSet(membersOf("erp", "web"), GUID, "dev")).toEqual([
      "zsjs023ctne0-auth-dev",
      "zsjs023ctne0-jobs-dev",
      "zsjs023ctne0-report-dev",
      "zsjs023ctne0-erp-dev",
      "zsjs023ctne0-web-dev",
    ]);
  });

  it("names one Application per member namespace, in the same order", () => {
    const members = membersOf("erp", "crm");
    expect(tenantApplicationSet(members, GUID, "test")).toEqual(tenantNamespaces(members, GUID).map((ns) => `${ns}-test`));
  });
});

describe("memberApplication", () => {
  it("returns <guid>-<member>-<stage> for a standing member and for an app alike", () => {
    expect(memberApplication(GUID, "auth", "prod")).toBe("zsjs023ctne0-auth-prod");
    expect(memberApplication(GUID, "erp", "dev")).toBe("zsjs023ctne0-erp-dev");
    expect(memberApplication(GUID, "web", "prod")).toBe("zsjs023ctne0-web-prod");
  });
});

describe("single-source-of-truth invariant", () => {
  // The render set (resolveFanout) and the watch/inventory set (tenantApplicationSet) MUST agree: the
  // DISTINCT Applications the renders map to == tenantApplicationSet (a member's several sources
  // collapse to the one <guid>-<member>-<stage>).
  it("the distinct Applications of resolveFanout equal tenantApplicationSet, across the matrix", () => {
    const cases: Array<{ apps: AppRef[]; stage: "dev" | "test" | "prod" }> = [
      { apps: [], stage: "dev" },
      { apps: [], stage: "test" },
      { apps: [app("erp")], stage: "dev" },
      { apps: [app("erp"), app("web"), app("crm")], stage: "prod" },
    ];
    for (const { apps, stage } of cases) {
      const distinct = [...new Set(resolveFanout(SPEC, apps, stage).map((m) => appOf(m, stage)))];
      expect(distinct).toEqual(tenantApplicationSet(membersOf(...apps.map((a) => a.name)), GUID, stage));
    }
  });

  // resolveMembers is the ONE resolution: what the registration records is exactly what the validator
  // renders, so a member the plan approved cannot differ from a member the appset deploys.
  it("resolveFanout is resolveMembers flattened — same members, same charts, same order", () => {
    const apps = [app("erp"), app("web")];
    const records = resolveMembers(SPEC, apps);
    const renders = resolveFanout(SPEC, apps, "prod");
    expect(renders.map((r) => r.member)).toEqual(records.flatMap((m) => m.sources.map(() => m.name)));
    expect(renders.map((r) => r.chart)).toEqual(records.flatMap((m) => m.sources.map((s) => s.chart)));
  });
});
