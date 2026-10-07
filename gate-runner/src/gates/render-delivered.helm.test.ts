// gate-runner/src/gates/render-delivered.helm.test.ts — a chart rendered by real helm with the argv and
// the delivered values file the gate stages: a chart that guards a value the ApplicationSet delivers
// passes where the manifest gives it and fails where it does not, as ArgoCD's render would.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveredValuesFile, renderArgs } from "./render-pinned-deps.gate.ts";

const helm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A chart whose MongoDB claim refuses an empty database list, as the demo consumer's did. */
function guardingChart(): string {
  const ws = mkdtempSync(join(tmpdir(), "gate-delivered-"));
  dirs.push(ws);
  const chart = join(ws, "chart");
  mkdirSync(join(chart, "templates"), { recursive: true });
  writeFileSync(join(chart, "Chart.yaml"), "apiVersion: v2\nname: acme\nversion: 0.1.0\n");
  writeFileSync(join(chart, "values.yaml"), "mongodb: {}\n");
  writeFileSync(join(chart, "values-test.yaml"), "");
  writeFileSync(join(chart, "templates", "claim.yaml"), [
    '{{- if not .Values.mongodb.databases }}{{ fail "mongodb.databases is delivered by the platform from the manifest\'s databases" }}{{ end }}',
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata: { name: claim }",
    "data: { host: {{ .Values.unitHost | quote }}, db: {{ index .Values.mongodb.databases 0 | quote }} }",
  ].join("\n"));
  return ws;
}

function render(ws: string, databases: string[]): { status: number | null; out: string } {
  const delivered = join(ws, "delivered.yaml");
  writeFileSync(delivered, deliveredValuesFile({ hostLabel: "acme", databases, keyPatterns: [], channelPatterns: [] }, "test", "example.com", ""));
  const run = spawnSync("helm", renderArgs("acme", "chart", "test", { beforeChart: [], afterChart: [] }, delivered), { cwd: ws, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe.skipIf(!helm)("a chart that guards a delivered value, rendered as the gate renders it", () => {
  it("PLANTED DEFECT: passes where the manifest names databases, with them delivered as ArgoCD delivers them", () => {
    const { status, out } = render(guardingChart(), ["acme_db"]);
    expect(status).toBe(0);
    expect(out).toContain('db: "acme_db"');
    expect(out).toContain('host: "acme.test.example.com"');
  });

  it("fails where the manifest names none, naming the delivered value", () => {
    const { status, out } = render(guardingChart(), []);
    expect(status).not.toBe(0);
    expect(out).toContain("mongodb.databases is delivered by the platform");
  });
});
