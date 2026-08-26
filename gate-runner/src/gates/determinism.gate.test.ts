// gate-runner/src/gates/determinism.gate.test.ts — G2 "determinism". One PASS test plus one FAIL test per failure
// mode (lookup / .Capabilities / .Release.IsInstall), and regression tests for the action-scanning
// rework: a lookup reachable only via `tpl` on a value, a subchart template, a data string that only
// mentions a forbidden word, and a doc comment that only mentions one. Each builds a minimal
// hand-crafted GateContext; every FAIL asserts the reason names the specific offending construct.
import { describe, expect, it } from "vitest";
import type { GateContext } from "./gate.ts";
import { determinismGate } from "./determinism.gate.ts";

function makeCtx(
  files: Record<string, string>,
  chartPath: string | null = "deploy/chart",
  manifest: GateContext["manifest"] = null,
): GateContext {
  return {
    targetName: "acme",
    stage: "dev",
    chartPath,
    clusterValueFiles: [],
    files: new Map(Object.entries(files)),
    manifest,
    rendered: [],
    dependencies: [],
  };
}

/** A parsed manifest that declares no chart — a build-only unit the sandbox actually read. */
function buildOnlyManifest(): GateContext["manifest"] {
  return {
    name: "acme",
    owner: "acme",
    builds: [{ name: "acme-api", containerfile: "Containerfile" }],
    envs: ["dev"],
    services: [],
    secrets: [],
  } as unknown as GateContext["manifest"];
}

// WHAT THIS GATE MAY CLAIM ON A RUN THAT READ NOTHING. G2 runs at pipeline.ts:87, BEFORE the
// `manifest !== null` guard at :90, so a report whose G1 failed reaches it with `chartPath` — the
// RUN's dispatch parameter — set and `manifest` null. One sentence for both cases said "the manifest
// declares no chart" about a report that carries no manifest: a PASS row reporting on the repository
// from an input it does not have, which is the apps3 defect from the other side.
describe("determinismGate on a build-only dispatch", () => {
  it("says the manifest declares no chart only when a manifest was actually parsed", () => {
    const r = determinismGate.check(makeCtx({}, null, buildOnlyManifest()));

    expect(r.status).toBe("pass");
    expect(r.found).toContain("The manifest declares no chart");
  });

  it("claims nothing about the manifest when the report carries none", () => {
    const r = determinismGate.check(makeCtx({}, null));

    expect(r.status).toBe("pass");
    expect(r.found).not.toContain("The manifest declares no chart");
    expect(r.found).toContain("No manifest was parsed for this report");
    expect(r.found).toContain("dispatched build-only");
  });

    it("does not report a clean scan when there was nothing under the chart path to scan", () => {
      // THE OTHER HALF of the same defect: chartPath is SET and matches no file the runner
      // materialised. "Scanned 0 template action(s) across 0 file(s); none use lookup" is exactly what
      // a chart full of violations looks like if the scan missed it, which is what the comment at the
      // head of the chartless branch forbids in as many words.
      const r = determinismGate.check(makeCtx({ 'README.md': 'not a chart file' }, 'deploy/chart'));

      expect(r.status).toBe('pass');
      expect(r.found).not.toContain('Scanned 0');
      expect(r.found).toContain('inspected nothing of this repository');
    });
});

describe("determinismGate determinism", () => {
  it("passes when no template uses a non-deterministic construct", () => {
    const ctx = makeCtx({
      // Deterministic constructs that must NOT trip the scan (.Values, .Release.Name are allowed).
      "deploy/chart/templates/deploy.yaml":
        "kind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\nimage: {{ .Values.image }}\n",
      "deploy/chart/templates/svc.yaml": "kind: Service\n",
      // values.yaml is now IN scope (helm can `tpl` a value), but here the forbidden words appear as
      // plain data with NO `{{ }}` action, so there is nothing to scan and the gate stays green.
      "deploy/chart/values.yaml": "note: lookup and .Capabilities live here but this is not a template\n",
      "deploy/chart/Chart.yaml": "name: acme\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  it("fails when a template uses lookup", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/secret.yaml":
        'data:\n  x: {{ (lookup "v1" "Secret" "ns" "name").data.x }}\n',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.severity).toBe("hard");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("lookup");
  });

  it("fails when a template uses .Capabilities", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/ing.yaml":
        "apiVersion: {{ if .Capabilities.KubeVersion.Minor }}networking.k8s.io/v1{{ end }}\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain(".Capabilities");
  });

  it("fails when a template uses .Release.IsInstall", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/job.yaml":
        "kind: Job\nmetadata:\n  annotations:\n    only: {{ .Release.IsInstall }}\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain(".Release.IsInstall");
  });

  it("normalizes a trailing slash on chartPath when locating the chart tree", () => {
    const ctx = makeCtx(
      { "deploy/chart/templates/cm.yaml": 'x: {{ lookup "v1" "ConfigMap" "" "" }}\n' },
      "deploy/chart/", // trailing slash must still resolve to files under deploy/chart/
    );
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("lookup");
  });

  // Regression (1): the lookup reaches helm only via `{{ tpl .Values.dyn . }}`; the lookup itself
  // lives in values.yaml (outside templates/). The old raw-templates/ scan missed it entirely because
  // the action in the template file has no forbidden token; scanning values*.yaml actions catches it.
  it("fails when a lookup lives in a value that a template feeds through tpl", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/cm.yaml": "data:\n  x: {{ tpl .Values.dyn . }}\n",
      "deploy/chart/values.yaml": 'dyn: \'{{ (lookup "v1" "Secret" "ns" "n").x }}\'\n',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.severity).toBe("hard");
    expect(r.reason).toContain("lookup");
    // The evidence must cite the file where the lookup action actually lives.
    expect((r.evidence ?? []).some((e) => e.file === "deploy/chart/values.yaml")).toBe(true);
  });

  // Regression (2): a subchart template under charts/*/templates/** was outside the old root-only
  // templates/ prefix, so its lookup was missed. It is now in scope (under <chartPath>/).
  it("fails when a subchart template uses lookup", () => {
    const ctx = makeCtx({
      "deploy/chart/charts/util/templates/job.yaml":
        'kind: Job\nmetadata:\n  name: {{ (lookup "v1" "ConfigMap" "" "").metadata.name }}\n',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("lookup");
    expect((r.evidence ?? []).some((e) => e.file === "deploy/chart/charts/util/templates/job.yaml")).toBe(true);
  });

  // Regression (3): a plain data string that merely contains the words "lookup"/".Capabilities" with
  // NO `{{ }}` action is not a template construct and must NOT false-trigger.
  it("passes when a data string only mentions lookup and .Capabilities (no action)", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/notes.yaml": "message: do not use lookup or .Capabilities\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // Regression (4): a Go-template COMMENT action that mentions a forbidden word does not execute it,
  // so it must NOT false-trigger — comment actions are excluded from the scan.
  it("passes when a comment action mentions a forbidden token", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/x.yaml": "kind: ConfigMap\n# {{/* avoid lookup */}}\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // Regression (5): helm renders EVERY file under templates/ regardless of extension, so a lookup in
  // templates/secret.json (valid YAML too) is executed at deploy. An extension allowlist missed it.
  it("fails a lookup in a non-.yaml template file (templates/*.json)", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/secret.json":
        '{"data":{"x":"{{ (lookup \\"v1\\" \\"Secret\\" \\"ns\\" \\"n\\").data.x }}"}}',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("lookup");
  });

  // Regression (6): an extension-less file under templates/ is still rendered by helm.
  it("fails a lookup in an extension-less template file", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/rendered": 'x: {{ lookup "v1" "ConfigMap" "" "" }}\n',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("lookup");
  });

  // Regression (7): a partial merely NAMED with "lookup" as a substring is not the lookup function.
  it("passes an include of a partial whose name contains the substring lookup", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/dep.yaml": '{{ include "app.lookupSidecars" . }}\n',
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });

  // Regression (8): a user value literally named Capabilities is not the built-in .Capabilities.
  it("passes a user value named Capabilities (not the built-in)", () => {
    const ctx = makeCtx({
      "deploy/chart/templates/cm.yaml": "tier: {{ .Values.Capabilities.tier }}\n",
    });
    const r = determinismGate.check(ctx);
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
  });
});
