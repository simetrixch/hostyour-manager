import { describe, it, expect } from "vitest";
import {
  catalogNeeds,
  fanoutOf,
  memberAppProject,
  memberApplication,
  memberNameRefusal,
  memberNamespace,
  resolveFanout,
  resolveMembers,
  tenantApplicationSet,
  tenantNamespaces,
  type AppRef,
  type FanoutMember,
  withAppNeeds,
} from "./tenant-fanout.ts";
import { TenantSpecSchema, type TenantSpec } from "../../../shared/consumer.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";

/** The standing members the product under test declares, and the members a tenant of it ends up with
 *  once its apps are added. Stated by the fixture, the way a real tenant's registration states its own
 *  — the platform holds no such list. */
const STANDING = ["auth", "jobs", "report"];
const membersOf = (...apps: string[]): string[] => [...STANDING, ...apps];

// A tenant product's fan-out block, parsed through the real schema so the fixture stays honest against
// the contract. `{app}` appears where the product's own file and resource names carry the app name.
const SPEC: TenantSpec = TenantSpecSchema.parse({
  members: [
    { name: "auth", path: "/auth", chart: "charts/example-auth", identityProvider: true, namespaceLabels: { "platform/redis-consumer": "true" } },
    { name: "jobs", path: "/jobs", chart: "charts/example-jobs" },
    { name: "report", path: "/reports", chart: "charts/example-report" },
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
  it("names a member namespace <guid>-<member>-<stage>, never the bare guid", () => {
    expect(memberNamespace(GUID, "auth", "dev")).toBe("zsjs023ctne0-auth-dev");
    expect(memberNamespace(GUID, "erp", "dev")).toBe("zsjs023ctne0-erp-dev");
    expect(tenantNamespaces(membersOf("erp"), GUID, "dev")).not.toContain(GUID);
  });

  it("holds the identity law per member: AppProject name == namespace", () => {
    for (const member of membersOf("erp", "web")) {
      expect(memberAppProject(GUID, member, "dev")).toBe(memberNamespace(GUID, member, "dev"));
    }
  });

  it("gives a tenant with several members one namespace and one AppProject EACH, pairwise different", () => {
    const members = membersOf("erp", "crm", "web");
    const namespaces = tenantNamespaces(members, GUID, "dev");
    expect(namespaces).toEqual([
      "zsjs023ctne0-auth-dev",
      "zsjs023ctne0-jobs-dev",
      "zsjs023ctne0-report-dev",
      "zsjs023ctne0-erp-dev",
      "zsjs023ctne0-crm-dev",
      "zsjs023ctne0-web-dev",
    ]);
    expect(new Set(namespaces).size).toBe(namespaces.length); // pairwise different
    for (const ns of namespaces) expect(ns.startsWith(`${GUID}-`)).toBe(true);
    // The AppProjects are the same six strings — one per member, never one shared project.
    expect(members.map((m) => memberAppProject(GUID, m, "dev"))).toEqual(namespaces);
  });

  it("leaves every OTHER member standing when one member is torn down", () => {
    const before = tenantNamespaces(membersOf("erp", "crm"), GUID, "dev");
    const after = tenantNamespaces(membersOf("crm"), GUID, "dev"); // erp removed
    expect(after).not.toContain(memberNamespace(GUID, "erp", "dev"));
    for (const ns of after) expect(before).toContain(ns);
    expect(after).toEqual(["zsjs023ctne0-auth-dev", "zsjs023ctne0-jobs-dev", "zsjs023ctne0-report-dev", "zsjs023ctne0-crm-dev"]);
  });

  it("addresses no member the product did not declare — the bracket is its members and its apps", () => {
    expect(membersOf("erp")).not.toContain("base");
    expect(tenantNamespaces(membersOf("erp"), GUID, "dev")).not.toContain(`${GUID}-base-dev`);
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
    expect(memberNamespace(GUID, erp.name, "dev")).toBe("zsjs023ctne0-erp-dev");
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
      members: [{ name: "idp", path: "/idp", chart: "charts/x", identityProvider: true, values: { note: "literal {app}" } }],
      perApp: { engine: { chart: "charts/e" }, front: { chart: "charts/f" } },
    });
    expect(resolveMembers(withToken, []).find((x) => x.name === "idp")!.sources[0]!.values).toEqual({ note: "literal {app}" });
  });

  it("records each member's path: a standing member's off the manifest, an app's /app/<name>, a website's admin /admin/<name>", () => {
    const website: AppRef = { name: "example-ch", folder: "web", site: "main" };
    const m = resolveMembers(SPEC, [app("erp"), website]);
    expect(m.map((x) => [x.name, x.path])).toEqual([
      ["auth", "/auth"], ["jobs", "/jobs"], ["report", "/reports"], ["erp", "/app/erp"], ["example-ch", "/admin/example-ch"],
    ]);
  });

  it("swaps the WHOLE front source for an app the product's override map names", () => {
    const web = resolveMembers(SPEC, [app("web")]).find((x) => x.name === "web")!;
    expect(web.sources[1]!.chart).toBe("charts/example-web");
    expect(web.sources[1]!.values).toEqual({ fullnameOverride: "example-web" });
    // The keyed lookup IS the selection: an app the map does not name keeps the default.
    const erp = resolveMembers(SPEC, [app("erp")]).find((x) => x.name === "erp")!;
    expect(erp.sources[1]!.chart).toBe("charts/example-ui");
  });

  it("gives a website the front of its folder with its own name and site, and drops a site key of an app that has none", () => {
    const sites = TenantSpecSchema.parse({
      members: [{ name: "idp", path: "/idp", chart: "charts/x", identityProvider: true }],
      perApp: {
        engine: { chart: "charts/e", valueFiles: ["values-{folder}.yaml"], values: { fullnameOverride: "e-{app}", appFolder: "{folder}", site: { id: "{site}" } } },
        front: {
          chart: "charts/f",
          values: { fullnameOverride: "f-{app}" },
          override: { web: { chart: "charts/w", values: { fullnameOverride: "w-{app}", site: { id: "{site}", engineService: "e-{app}" } } } },
        },
      },
    });
    const website: AppRef = { name: "example-ch", folder: "web", site: "main" };
    const [engine, front] = resolveMembers(sites, [website]).find((x) => x.name === "example-ch")!.sources;
    expect(engine).toEqual({ chart: "charts/e", valueFiles: ["values-web.yaml"], values: { fullnameOverride: "e-example-ch", appFolder: "web", site: { id: "main" } } });
    expect(front).toEqual({ chart: "charts/w", valueFiles: [], values: { fullnameOverride: "w-example-ch", site: { id: "main", engineService: "e-example-ch" } } });
    // An app that is no website runs the folder of its own name, and its site keys go.
    const [erpEngine, erpFront] = resolveMembers(sites, [app("erp")]).find((x) => x.name === "erp")!.sources;
    expect(erpEngine).toEqual({ chart: "charts/e", valueFiles: ["values-erp.yaml"], values: { fullnameOverride: "e-erp", appFolder: "erp" } });
    expect(erpFront!.chart).toBe("charts/f");
    // An app named after the website folder, with no site, keeps that folder's front.
    const [, webFront] = resolveMembers(sites, [app("web")]).find((x) => x.name === "web")!.sources;
    expect(webFront).toEqual({ chart: "charts/w", valueFiles: [], values: { fullnameOverride: "w-web", site: { engineService: "e-web" } } });
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
    expect(resolveFanout(SPEC, [], "dev").map((m) => memberNamespace(GUID, m.member, "dev"))).toEqual([
      "zsjs023ctne0-auth-dev",
      "zsjs023ctne0-jobs-dev",
      "zsjs023ctne0-report-dev",
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
    expect(new Set(perApp.map((x) => memberNamespace(GUID, x.member, "dev")))).toEqual(new Set(["zsjs023ctne0-erp-dev"]));
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

  it("carries each source's resolved values on its render, and fanoutOf renders members already resolved the same way", () => {
    const members = resolveMembers(SPEC, [app("erp")]);
    const direct = resolveFanout(SPEC, [app("erp")], "prod");
    expect(fanoutOf(members, "prod")).toEqual(direct);
    expect(direct.find((x) => x.name === "erp-1")?.values).toEqual({ fullnameOverride: "example-engine-erp" });
    expect(direct.find((x) => x.name === "auth")?.values).toEqual({});
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
    expect(tenantApplicationSet(members, GUID, "test")).toEqual(tenantNamespaces(members, GUID, "test"));
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

describe("catalogNeeds and withAppNeeds", () => {
  const catalog: AppsManifest = {
    apps: [
      { name: "erp", title: "ERP", description: "", selections: {}, needs: ["report"] },
      { name: "crm", title: "CRM", description: "", selections: {}, needs: [] },
      { name: "web", title: "Website", description: "", selections: {}, needs: ["jobs"], sites: ["main"] },
    ],
  };

  it("reads each app's needs off the catalog entry of its folder, a website's off the folder it runs, and gives an app the catalog does not name none", () => {
    const apps: AppRef[] = [app("erp"), app("crm"), { name: "example-ch", folder: "web", site: "main" }, app("ghost")];
    expect(catalogNeeds(apps, catalog)).toEqual({ erp: ["report"], crm: [], "example-ch": ["jobs"] });
  });

  it("sets each app's needs as listed, and none where none is listed, replacing what an entry carried", () => {
    const apps = [{ name: "erp", needs: ["stale"] }, { name: "crm", needs: ["stale"] }, { name: "web" }];
    expect(withAppNeeds(apps, { erp: ["report"] })).toEqual([{ name: "erp", needs: ["report"] }, { name: "crm", needs: [] }, { name: "web", needs: [] }]);
  });
});

describe("memberNameRefusal — the names an app or a website may not take", () => {
  const PRODUCT = TenantSpecSchema.parse({
    members: [
      { name: "auth", path: "/auth", chart: "charts/auth", identityProvider: true },
      { name: "jobs", path: "/jobs", chart: "charts/jobs" },
      { name: "report", path: "/reports", chart: "charts/report" },
      { name: "web", path: "/", chart: "charts/web" },
    ],
    reservedMemberNames: ["api", "ws", "health", "tenant", "admin", "app"],
    perApp: { engine: { chart: "charts/e" }, front: { chart: "charts/f" } },
  });

  it.each(["api", "ws", "health", "tenant", "admin", "app"])("refuses %s, naming it and the product's reserved words", (name) => {
    expect(memberNameRefusal(name, PRODUCT)).toBe(`"${name}" is reserved by the product for its engine (api, ws, health, tenant, admin, app)`);
  });

  it.each(["auth", "jobs", "report", "web"])("refuses %s, naming it as a standing member of every tenant", (name) => {
    expect(memberNameRefusal(name, PRODUCT)).toBe(`"${name}" is a standing member of every tenant of this product`);
  });

  it("PLANTED INNOCENT: lets an ordinary app name pass", () => {
    expect(memberNameRefusal("workshop", PRODUCT)).toBeNull();
  });
});
