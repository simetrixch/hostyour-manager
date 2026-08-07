// gate-runner/src/gates/g22.test.ts
// G22 "database sync ordering" — the per-consumer-PostgreSQL contract gate. Proves it PASSES
// swissbookai's compliant chart (lowest wave -3, migrate
// Job a plain wave -1 resource), REJECTS a wave below the -10 floor (-21 and the -11 boundary), and
// REJECTS a PreSync hook that depends on the database — while being a NO-OP for every existing
// consumer (no such waves, no such hooks). Each context is hand-built and minimal (g6/g15 idiom).
import { describe, expect, it } from "vitest";
import { g22 } from "./g22.ts";
import type { GateContext, RenderedDoc } from "./gate.ts";

const WAVE = "argocd.argoproj.io/sync-wave";
const HOOK = "argocd.argoproj.io/hook";

/** A rendered doc; `annotations` go on metadata, `extraRaw` is spread onto raw (e.g. a pod spec that
 *  references the DB Secret), and `raw` is overridable last so a test can inject a hostile shape. */
function doc(kind: string, name: string, annotations?: Record<string, unknown>, extraRaw: Record<string, unknown> = {}, docIndex = 0): RenderedDoc {
  return {
    env: "dev",
    docIndex,
    apiVersion: "v1",
    kind,
    name,
    namespace: "acme",
    raw: { apiVersion: "v1", kind, metadata: { name, ...(annotations ? { annotations } : {}) }, ...extraRaw },
  };
}

/** A pod spec whose container reads a key from the platform DB Secret `postgresql-credentials`. */
function readsDbSecret(): Record<string, unknown> {
  return {
    spec: {
      template: {
        spec: {
          containers: [
            { name: "app", env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "postgresql-credentials", key: "POSTGRES_PASSWORD" } } }] },
          ],
        },
      },
    },
  };
}

function makeCtx(rendered: RenderedDoc[]): GateContext {
  return {
    targetName: "acme",
    stage: "dev",
    chartPath: "deploy/chart",
    clusterValueFiles: [],
    files: new Map(),
    manifest: null,
    rendered,
    dependencies: [],
  };
}

describe("g22 database sync ordering", () => {
  it("PASSES swissbookai's compliant chart: lowest wave -3, migrate Job a plain wave -1 resource (not a PreSync hook)", () => {
    // A real consumer chart, taken verbatim: its lowest wave is -3
    // (secretstore.yaml:20) and its migrate Job is a plain wave -1 resource (job-migrate.yaml:28),
    // NOT a hook. The migrate Job even reads the DB — a plain resource that references the database is
    // fine; only a PreSync hook that does is the violation. Everything here is at or above the floor.
    const rendered = [
      doc("SecretStore", "vault-backend", { [WAVE]: "-3" }),
      doc("Job", "swissbookai-migrate", { [WAVE]: "-1" }, readsDbSecret(), 1),
      doc("Deployment", "swissbookai", { [WAVE]: "0" }, {}, 2),
      doc("Service", "swissbookai", undefined, { spec: { type: "ClusterIP" } }, 3),
    ];
    const r = g22.check(makeCtx(rendered));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  it("is a NO-OP for a consumer that declares no sync-wave and no hook (every existing consumer)", () => {
    // The whole no-regression claim: a normal consumer (a Deployment + Service with no wave/hook
    // annotations at all — the shape example-auth/plane/post render) is untouched by this gate.
    const rendered = [
      doc("Deployment", "acme-web", undefined, { spec: { template: { spec: { containers: [{ name: "app" }] } } } }),
      doc("Service", "acme-web", undefined, { spec: { type: "ClusterIP" } }, 1),
    ];
    const r = g22.check(makeCtx(rendered));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
    expect(r.found).toContain("nothing that could violate");
  });

  it("PASSES wave -10 exactly (the floor is inclusive)", () => {
    const r = g22.check(makeCtx([doc("Job", "acme-setup", { [WAVE]: "-10" })]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // FAILURE MODE 1: a wave below the floor.
  it("REJECTS a consumer resource at wave -21 (claiming the platform's own database wave)", () => {
    const r = g22.check(makeCtx([doc("Deployment", "acme-db-shadow", { [WAVE]: "-21" })]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("-21");
    expect(r.reason).toContain("-10");
    expect(r.evidence?.[0]).toMatchObject({ source: "rendered", kind: "Deployment", name: "acme-db-shadow" });
    expect(r.evidence?.[0]?.fieldPath).toContain(WAVE);
  });

  it("REJECTS the -11 boundary (one below the inclusive floor)", () => {
    const r = g22.check(makeCtx([doc("Job", "acme-early", { [WAVE]: "-11" })]));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("-11");
  });

  it("REJECTS an UNQUOTED numeric wave below the floor (YAML parsed it as a number, not a string)", () => {
    const r = g22.check(makeCtx([doc("Deployment", "acme-x", { [WAVE]: -21 })]));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("-21");
  });

  // FAILURE MODE 2: a PreSync hook that depends on the database.
  it("REJECTS a PreSync hook that references the database Secret postgresql-credentials", () => {
    const r = g22.check(makeCtx([doc("Job", "acme-db-init", { [HOOK]: "PreSync" }, readsDbSecret())]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("PreSync");
    expect(r.reason).toContain("postgresql-credentials");
    expect(r.evidence?.[0]?.fieldPath).toContain(HOOK);
  });

  it("REJECTS a PreSync hook declared with a multi-phase annotation (PreSync,PostSync) that depends on the database", () => {
    const r = g22.check(makeCtx([doc("Job", "acme-db-init", { [HOOK]: "PreSync,PostSync" }, readsDbSecret())]));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("PreSync");
  });

  it("PASSES a PreSync hook that does NOT touch the database (the image-guard) — the no-op for existing PreSync hooks", () => {
    // The asymmetry this gate rests on: ArgoCD's image-guard is a PreSync hook (apps/consumer-image-guard
    // job.yaml:30). A PreSync hook is only a violation when it depends on the database — one that never
    // references postgresql-credentials must pass, or this gate would break the image-guard.
    const guard = doc("Job", "acme-image-guard", { [HOOK]: "PreSync" }, { spec: { template: { spec: { containers: [{ name: "guard", image: "zot.example/image-guard:1" }] } } } });
    const r = g22.check(makeCtx([guard]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  it("PASSES a plain (non-hook) resource that references the database at a valid wave — only PreSync hooks are policed for DB deps", () => {
    const r = g22.check(makeCtx([doc("Job", "acme-migrate", { [WAVE]: "-1" }, readsDbSecret())]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  it("reports the FIRST violating document when several are present", () => {
    const rendered = [
      doc("SecretStore", "vault-backend", { [WAVE]: "-3" }),
      doc("Deployment", "acme-bad", { [WAVE]: "-21" }, {}, 1),
      doc("Job", "acme-worse", { [HOOK]: "PreSync" }, readsDbSecret(), 2),
    ];
    const r = g22.check(makeCtx(rendered));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("acme-bad"); // the wave violator comes first in the stream
  });

  it("does not crash on a hostile doc whose metadata is a non-object", () => {
    const hostile = doc("Deployment", "evil", { [WAVE]: "-99" });
    hostile.raw = { metadata: "not-an-object" };
    const r = g22.check(makeCtx([hostile]));
    expect(r.status).toBe("pass"); // no readable annotations ⇒ nothing evaluable ⇒ no violation
    expect(r.reason).toBeNull();
  });

  it("ignores a non-integer sync-wave value (not a floor violation)", () => {
    const r = g22.check(makeCtx([doc("Deployment", "acme-x", { [WAVE]: "not-a-number" })]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });
});
