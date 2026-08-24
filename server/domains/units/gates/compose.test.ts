import { describe, it, expect } from "vitest";
import { composeReport, gateBuildNameUniqueness, gateRepoAccess, gateBuildDeclaration, gateFqdnGrant, gateUnitName, PLATFORM_NAMESPACES } from "./compose.ts";
import { mapBuildsToChartPins } from "../builds.ts";
import { RESERVED_PROJECT_NAMES } from "../../../adapters/kube/port.ts";
import type { GateReport, GateResult } from "../../../../shared/gates.ts";

const SHA = "a".repeat(40);

function runnerReport(over: Partial<GateReport> = {}): GateReport {
  const g1: GateResult = {
    id: "G1", title: "manifest present", severity: "hard", status: "pass",
    expected: "deploy/platform.yaml exists and validates", found: "manifest parsed", reason: null, detail: "ok",
  };
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "main", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null,
    dependencies: [], gates: [g1],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "runner-hash",
    ...over,
  };
}

const chartPins = (...images: string[]): string =>
  ["builds:", ...images.map((i) => `  - name: ${i}\n    image: ${i}\n    tag: "1.0.0-stable-20260719120000-abc1234"`)].join("\n") + "\n";

function chart(declaredBuilds: string[], valuesStageYaml: string | null) {
  return {
    path: "deploy/chart",
    stage: "prod" as const,
    mapping: mapBuildsToChartPins({ declaredBuilds, source: "deploy/chart/values-prod.yaml", valuesStageYaml }),
  };
}

describe("G17 repo access (hard)", () => {
  it("passes on a successful clone and fails without leaking a credential", () => {
    expect(gateRepoAccess({ ok: true, detail: "clone succeeded" }).status).toBe("pass");
    const denied = gateRepoAccess({ ok: false, detail: "clone failed: authentication required" });
    expect(denied.status).toBe("fail");
    expect(denied.severity).toBe("hard");
    expect(denied.reason).not.toBeNull();
  });
});

describe("G23 unit name (hard)", () => {
  it("passes a name outside every reserved space", () => {
    for (const name of ["acme", "example-auth", "swissbookai"]) {
      const g = gateUnitName({ unitName: name, tenantSubdomains: [] });
      expect(g.status).toBe("pass");
      expect(g.severity).toBe("hard");
      expect(g.reason).toBeNull();
    }
  });

  it("refuses every platform namespace — the unit's name IS its namespace, so the chart would sync into the platform's", () => {
    for (const name of PLATFORM_NAMESPACES) {
      const g = gateUnitName({ unitName: name, tenantSubdomains: [] });
      expect(g.status, `"${name}" must be refused`).toBe("fail");
      expect(g.found).toContain("platform namespace");
    }
  });

  it("refuses a name in the derived build-namespace space, naming the unit whose build namespace it is", () => {
    // The AppProject destination is the unit's name, so a consumer named example-auth-build is
    // pinned into example-auth's build namespace — where the shared registrations push credential and
    // example-auth's repo PAT are materialized.
    const g = gateUnitName({ unitName: "example-auth-build", tenantSubdomains: [] });
    expect(g.status).toBe("fail");
    expect(g.found).toContain('"example-auth"');
    expect(g.reason).not.toBeNull();
    // The space is reserved wholesale: it is refused even when no unit of that name is onboarded
    // yet, because onboarding that unit later would derive exactly this namespace.
    expect(gateUnitName({ unitName: "nobody-yet-build", tenantSubdomains: [] }).status).toBe("fail");
  });

  it("refuses Kubernetes' kube- prefix", () => {
    for (const name of ["kube-public", "kube-node-lease"]) {
      expect(gateUnitName({ unitName: name, tenantSubdomains: [] }).status).toBe("fail");
    }
  });

  it("refuses every shared ArgoCD project name — the per-unit AppProject is named by the unit", () => {
    for (const name of RESERVED_PROJECT_NAMES) {
      expect(gateUnitName({ unitName: name, tenantSubdomains: [] }).status, `"${name}" must be refused`).toBe("fail");
    }
  });

  it("refuses a name a tenant already stands on — its IdP scopes every session cookie to that exact host", () => {
    // A tenant with subdomain "simetrix" serves auth./web./jobs. under it and sets its session
    // cookies with Domain=simetrix.<unitApex>. A consumer of that name serves simetrix.<unitApex>
    // itself, so every browser holding a tenant session would send it there — a full takeover with
    // nothing of the tenant touched. The mirror lives in the create-tenant subdomain belt.
    const g = gateUnitName({ unitName: "simetrix", tenantSubdomains: ["simetrix", "other"] });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("session cookie");
    expect(gateUnitName({ unitName: "acme", tenantSubdomains: ["simetrix"] }).status).toBe("pass");
  });

  it("fails the whole set of gates — it is a HARD gate", () => {
    const g23 = gateUnitName({ unitName: "mongodb", tenantSubdomains: [] });
    expect(composeReport(runnerReport(), [gateRepoAccess({ ok: true, detail: "ok" }), g23]).verdict).toBe("fail");
  });
});

describe("G16 build-name uniqueness (hard)", () => {
  it("passes when no other unit claims the declared names", () => {
    const g = gateBuildNameUniqueness({
      unitName: "hostyour-manager",
      buildNames: ["manager", "gate-runner"],
      foreignBuilds: [{ unit: "example-platform", build: "example-engine" }],
    });
    expect(g.status).toBe("pass");
    expect(g.severity).toBe("hard");
    expect(g.reason).toBeNull();
  });

  it("passes a name that neither equals its unit nor is prefixed by it — the old ownership law is gone", () => {
    // The platform's own names violate that law: example-engine belongs to unit example-platform,
    // manager to hostyour-manager. Uniqueness is checked against the other units, not constructed.
    const g = gateBuildNameUniqueness({ unitName: "example-platform", buildNames: ["example-engine", "example-ui", "example-web"], foreignBuilds: [] });
    expect(g.status).toBe("pass");
  });

  it("fails naming the foreign unit AND the build name", () => {
    const g = gateBuildNameUniqueness({
      unitName: "unit-b",
      buildNames: ["shared-api"],
      foreignBuilds: [{ unit: "unit-a", build: "shared-api" }],
    });
    expect(g.status).toBe("fail");
    expect(g.severity).toBe("hard");
    expect(g.found).toContain("unit-a");
    expect(g.found).toContain("shared-api");
    expect(g.reason).not.toBeNull();
  });

  it("fails the whole set of gates — it is a HARD gate", () => {
    const g16 = gateBuildNameUniqueness({ unitName: "unit-b", buildNames: ["shared-api"], foreignBuilds: [{ unit: "unit-a", build: "shared-api" }] });
    expect(composeReport(runnerReport(), [gateRepoAccess({ ok: true, detail: "ok" }), g16]).verdict).toBe("fail");
  });
});

describe("G18 build declaration (hard, two halves)", () => {
  it("manifest half: an empty builds[] fails, chart or no chart", () => {
    for (const c of [null, chart([], chartPins())]) {
      const g = gateBuildDeclaration({ declaredBuilds: [], chart: c });
      expect(g.status).toBe("fail");
      expect(g.severity).toBe("hard");
      expect(g.found).toBe("no build declared in deploy/platform.yaml");
    }
  });

  it("chart half: passes when values-<stage>.yaml pins every declared build", () => {
    const g = gateBuildDeclaration({ declaredBuilds: ["acme-api"], chart: chart(["acme-api"], chartPins("acme-api")) });
    expect(g.status).toBe("pass");
    expect(g.reason).toBeNull();
    expect(g.found).toContain("deploy/chart/values-prod.yaml");
  });

  it("chart half: fails naming the declared build the chart does not pin", () => {
    const g = gateBuildDeclaration({ declaredBuilds: ["acme-api", "acme-worker"], chart: chart(["acme-api", "acme-worker"], chartPins("acme-api")) });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("acme-worker");
    expect(g.evidence?.[0]?.value).toBe("acme-worker");
  });

  it("chart half: a values file that breaks the pin grammar fails with the refusal text", () => {
    const g = gateBuildDeclaration({
      declaredBuilds: ["acme-api"],
      chart: chart(["acme-api"], 'builds:\n  - name: acme-api\n    image: zot.example.com/acme-api\n    tag: "1"\n'),
    });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("pin grammar");
  });

  it("a build-only unit is EMITTED, not skipped: the manifest half holds and the chart half says it has no object", () => {
    const g = gateBuildDeclaration({ declaredBuilds: ["manager", "gate-runner"], chart: null });
    expect(g.status).toBe("pass");
    expect(g.found).toContain("build-only — no chart to check");
  });
});

describe("G19 fqdn grant (hard)", () => {
  const foreign = [{ unit: "unit-a", stage: "prod" as const, fqdn: "shop.example.org" }];

  it("passes — and says so — when no fqdn is declared", () => {
    const g = gateFqdnGrant({ unitName: "acme", fqdn: null, unitApex: null, clusterDomain: null, foreignFqdns: [] });
    expect(g.status).toBe("pass");
    expect(g.severity).toBe("hard");
    expect(g.found).toContain("no fqdn declared");
    expect(g.reason).toBeNull();
  });

  it("passes a declared fqdn nobody serves: outside the apex, attested by no other unit", () => {
    const g = gateFqdnGrant({ unitName: "acme", fqdn: "app.acme.example.org", unitApex: "units.example.com", clusterDomain: "m1.example.com", foreignFqdns: foreign });
    expect(g.status).toBe("pass");
    expect(g.found).toContain("app.acme.example.org");
  });

  it("fails naming the unit AND the stage file that already attest the fqdn", () => {
    const g = gateFqdnGrant({ unitName: "acme", fqdn: "shop.example.org", unitApex: "units.example.com", clusterDomain: null, foreignFqdns: foreign });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("unit-a");
    expect(g.found).toContain("registrations/unit-a/prod.yaml");
    expect(g.reason).not.toBeNull();
  });

  it("fails anything under (or equal to) the cluster's unitApex — those names are the platform's own composition", () => {
    for (const fqdn of ["other.units.example.com", "units.example.com"]) {
      const g = gateFqdnGrant({ unitName: "acme", fqdn, unitApex: "units.example.com", clusterDomain: null, foreignFqdns: [] });
      expect(g.status).toBe("fail");
      expect(g.found).toContain("units.example.com");
    }
    // A SUFFIX that is not a label boundary is a different domain, not a sub-name of the apex.
    expect(gateFqdnGrant({ unitName: "acme", fqdn: "not-units.example.com", unitApex: "units.example.com", clusterDomain: null, foreignFqdns: [] }).status).toBe("pass");
  });

  it("fails anything under (or equal to) the cluster's own FQDN — the platform's infrastructure hostnames live there and have no registration", () => {
    // The case the unitApex clause cannot see: an apex that is NOT a parent of the cluster FQDN.
    for (const fqdn of ["vault.m1.internal.example", "m1.internal.example"]) {
      const g = gateFqdnGrant({ unitName: "acme", fqdn, unitApex: "customers.example", clusterDomain: "m1.internal.example", foreignFqdns: [] });
      expect(g.status).toBe("fail");
      expect(g.found).toContain("m1.internal.example");
    }
    // The label boundary again: a name merely ENDING in the FQDN's text is a different domain.
    expect(gateFqdnGrant({ unitName: "acme", fqdn: "not-m1.internal.example", unitApex: "customers.example", clusterDomain: "m1.internal.example", foreignFqdns: [] }).status).toBe("pass");
  });

  it("fails THIS unit's fqdn when its own OTHER stage already attests it — one FQDN cannot serve two stages", () => {
    const g = gateFqdnGrant({
      unitName: "acme",
      fqdn: "shop.example.org",
      unitApex: "units.example.com",
      clusterDomain: null,
      foreignFqdns: [{ unit: "acme", stage: "dev", fqdn: "shop.example.org" }],
    });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("this unit");
    expect(g.found).toContain("registrations/acme/dev.yaml");
  });

  it("fails the whole set of gates — it is a HARD gate", () => {
    const g19 = gateFqdnGrant({ unitName: "acme", fqdn: "shop.example.org", unitApex: null, clusterDomain: null, foreignFqdns: foreign });
    expect(composeReport(runnerReport(), [gateRepoAccess({ ok: true, detail: "ok" }), g19]).verdict).toBe("fail");
  });
});

describe("composeReport", () => {
  it("appends manager gates and keeps the runner's reportHash untouched", () => {
    const c = composeReport(runnerReport(), [gateRepoAccess({ ok: true, detail: "clone succeeded" })]);
    expect(c.gates.map((g) => g.id)).toEqual(["G1", "G17"]);
    expect(c.reportHash).toBe("runner-hash");
    expect(c.verdict).toBe("pass");
  });

  it("flips the verdict to fail when a hard manager gate fails, even if the runner passed", () => {
    const c = composeReport(runnerReport(), [gateRepoAccess({ ok: false, detail: "clone failed" })]);
    expect(c.verdict).toBe("fail");
  });

  it("stays fail when the runner failed even if every manager gate passes", () => {
    const c = composeReport(runnerReport({ verdict: "fail" }), [gateRepoAccess({ ok: true, detail: "clone succeeded" })]);
    expect(c.verdict).toBe("fail");
  });
});
