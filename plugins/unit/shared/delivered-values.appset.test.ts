// The ONE test that reads both sides of the delivered values: the composition the sandbox gate renders
// with (delivered-values.ts) against the consumers ApplicationSet of hostyour-cloud, rendered as the
// ApplicationSet controller renders it (hostyour-cloud scripts/appset-render, with Go).
//
// ABSENT, THE CASE FAILS, naming what it looked for, as cluster-marking.test.ts does for hostyour-deploy:
// a skip reads exactly like a pass. Only a run that sets HOSTYOUR_CLOUD_CHECKOUT_MAY_BE_ABSENT goes
// without the sibling checkout or Go, and then it says NOT RUN.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { deliveredValues } from "./delivered-values.ts";

/** The sibling checkout: beside the main checkout, and through the neighbour link beside a worktree. */
const cloud = fileURLToPath(new URL("../../../../hostyour-cloud", import.meta.url));
const appsetFile = join(cloud, "clusters/argocd/files/consumers-appset.yaml");
const CLOUD_CHECKOUT_MAY_BE_ABSENT = "HOSTYOUR_CLOUD_CHECKOUT_MAY_BE_ABSENT";
const ready = existsSync(appsetFile) && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const notRun = !ready && process.env[CLOUD_CHECKOUT_MAY_BE_ABSENT] !== undefined;
// eslint-disable-next-line no-console -- the skip must be loud, not silent: a skip reads as a pass
if (notRun) console.warn(`NOT RUN: the delivered values contract case, because ${appsetFile} or Go is absent and ${CLOUD_CHECKOUT_MAY_BE_ABSENT} is set`);
const APEX = { dev: "dev.example.com", test: "test.example.com", prod: "example.com" } as const;
const API_HOST = "100.64.0.7";

/** The render program, compiled once: a `go run` per render compiles it again each time, which on a
 *  cold build cache (a CI runner) outlasts a test's time. */
let renderDir = "";
let renderBin = "";

/** The unit's own source's valuesObject, as the ApplicationSet renders it for `registration`. */
function appsetDelivers(registration: Record<string, unknown>): Record<string, unknown> {
  const appset = parse(readFileSync(appsetFile, "utf8")) as { spec: { templatePatch: string; goTemplateOptions: string[] } };
  const template = appset.spec.templatePatch
    .replaceAll("__STAGE_APEX_DEV__", APEX.dev).replaceAll("__STAGE_APEX_TEST__", APEX.test).replaceAll("__STAGE_APEX_PROD__", APEX.prod)
    .replaceAll("__API_HOST__", API_HOST);
  const answer = JSON.parse(execFileSync(renderBin, [], {
    encoding: "utf8",
    input: JSON.stringify({ template, options: appset.spec.goTemplateOptions, params: [registration] }),
  })) as Array<{ output?: string; error?: string }>;
  if (answer[0]?.error) throw new Error(answer[0].error);
  const spec = (parse(answer[0]!.output!) as { spec: { sources: Array<{ helm?: { valuesObject?: Record<string, unknown> } }> } }).spec;
  return spec.sources.map((s) => s.helm?.valuesObject).find((v) => v !== undefined && "unitHost" in v)!;
}

/** A registration as the Manager writes it at onboarding, from the manifest's fields, at test. */
const registration = (fields: { databases: string[]; keyPatterns: string[]; channelPatterns: string[]; smtpEntry?: { service: string; port: number } }) => ({
  name: "acme", repoURL: "https://example.test/acme.git", owner: "acme", onboardedAt: "2026-10-07T00:00:00Z",
  suspended: false, quiesced: false, removing: false, chartPath: "deploy/chart", cluster: "apps1",
  services: [], size: "small", mongodb: "standalone",
  quota: { requestsCpu: "1", requestsMemory: "2Gi", limitsCpu: "4", limitsMemory: "8Gi", pods: "16", persistentVolumeClaims: "4" },
  host: "acme",
  path: { path: "registrations/acme", basename: "acme", filename: "test.yaml", segments: ["registrations", "acme"] },
  values: { stage: "test" },
  ...fields,
});

describe.skipIf(notRun)("the values the gate renders with are the consumers ApplicationSet's", () => {
  // Downloading the modules and compiling is the slow part, so it gets the time once, here.
  beforeAll(() => {
    if (!ready) return;
    renderDir = mkdtempSync(join(tmpdir(), "appset-render-"));
    renderBin = join(renderDir, "appset-render");
    execFileSync("go", ["build", "-o", renderBin, "."], { cwd: join(cloud, "scripts/appset-render"), stdio: "pipe" });
  }, 180_000);
  afterAll(() => {
    if (renderDir) rmSync(renderDir, { recursive: true, force: true });
  });

  it("PLANTED DEFECT: delivers the same host, zone, databases and redis grant, and the same SMTP entry", () => {
    expect(ready, `the consumers ApplicationSet is not at ${appsetFile}, or Go is missing: check out hostyour-cloud beside this checkout and install Go, or set ${CLOUD_CHECKOUT_MAY_BE_ABSENT}`).toBe(true);
    for (const fields of [
      { databases: ["acme_db"], keyPatterns: ["acme:*"], channelPatterns: ["acme.*"] },
      { databases: [], keyPatterns: [], channelPatterns: [], smtpEntry: { service: "acme-mta", port: 2525 } },
    ]) {
      expect(deliveredValues({ hostLabel: "acme", stage: "test", unitApex: "example.com", apiHost: API_HOST, ...fields })).toEqual(appsetDelivers(registration(fields)));
    }
  });
});
