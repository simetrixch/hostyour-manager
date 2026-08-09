// gate-runner/src/g1.ts
// G1 "structure" (hard). The pipeline's manifest-parse phase: it is the ONE gate
// that turns the untrusted bundle tree into a validated ConsumerManifest, and every later hard gate
// fails fast when it could not (GateContext.manifest === null). It is NOT a CheckGate — it runs
// before a context exists and additionally PRODUCES the manifest — so it is a plain pure function.
//
// It fails CLOSED on the first structural violation, in this order:
//   1. deploy/platform.yaml exists, parses as YAML, and schema-validates as a ConsumerManifest.
//   2. identity law: manifest.name == the onboarding target, and (if a Chart.yaml ships at chartPath)
//      Chart.yaml.name == manifest.name.
//   3. if the manifest declares a chart, that chart's Chart.yaml is actually in the cloned tree.
//   4. every declared env has its base values.yaml and its per-env values-<env>.yaml overlay.
//   5. the stage being onboarded is one of the declared envs.
// The report contract is: the returned manifest is non-null IFF status == "pass". Every input
// here is hostile (parsed YAML, cloned repo contents), so each read is guarded — a platform.yaml that parses
// to a string, a Chart.yaml with no name field, a non-Map `files` — must reject cleanly, never crash.
import { parse } from "yaml";
import { fail, pass } from "./gates/result.ts";
import type { GateResult } from "../../shared/gates.ts";
import { ConsumerManifestSchema, type ConsumerManifest } from "../../shared/consumer.ts";

const ID = "G1";
const TITLE = "structure";
const SEVERITY = "hard" as const;
const MANIFEST_PATH = "deploy/platform.yaml";
const ISSUE_CAP = 6; // keep the schema-issue summary bounded for a hostile manifest.
const TEXT_CAP = 200; // cap any echoed untrusted string (a parse-error message, a chart name).

export interface StructureInput {
  files: ReadonlyMap<string, string>;
  chartPath: string;
  targetName: string;
  stage: string;
}

export interface StructureOutcome {
  result: GateResult;
  manifest: ConsumerManifest | null;
}

/** Read a bundled file's contents defensively: a non-Map `files`, or a value that is somehow not a
 *  string, is treated as "absent" rather than crashing the gate. An empty file returns "" (present). */
function getFile(files: ReadonlyMap<string, string>, path: string): string | undefined {
  if (files === null || typeof files !== "object" || typeof files.get !== "function") return undefined;
  const value = files.get(path);
  return typeof value === "string" ? value : undefined;
}

function has(files: ReadonlyMap<string, string>, path: string): boolean {
  return getFile(files, path) !== undefined;
}

function fileCount(files: ReadonlyMap<string, string>): number {
  return files !== null && typeof files === "object" && typeof files.size === "number" ? files.size : 0;
}

/** Strip trailing slash(es) so path joins never double a separator; a non-string chartPath -> "". */
function normalizeDir(chartPath: string): string {
  const raw = typeof chartPath === "string" ? chartPath : "";
  return raw.replace(/\/+$/, "");
}

/** Join a (possibly empty) directory and a file name without emitting a leading slash. */
function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function cap(text: unknown): string {
  // Coerce defensively: stage/targetName are typed string but a direct/test caller can pass a
  // non-string, and cap() must never crash while building a fail reason (module contract).
  const s = typeof text === "string" ? text : String(text);
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s;
}

/** The value of a top-level `name:` key, or undefined if the text does not parse to a mapping or has
 *  no `name`. Never throws: a hostile Chart.yaml is data, not a crash. The returned value is unknown
 *  (it may not be a string) and is compared by strict equality, so a non-string never matches. */
function readNameField(text: string): unknown {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return undefined;
  }
  if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
    return (doc as Record<string, unknown>).name;
  }
  return undefined;
}

/** A short human display of a parsed name value for the `found` sentence. */
function nameDisplay(value: unknown): string {
  if (typeof value === "string") return `"${cap(value)}"`;
  if (value === undefined) return "no name field";
  return "a non-string value";
}

/** One-line summary of the first few zod issues. Structurally typed so no zod value/type import is
 *  needed; each path segment is String()-coerced (a symbol segment would make Array.join throw). */
function issueSummary(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  const shown = issues.slice(0, ISSUE_CAP).map((i) => {
    const p = i.path.length > 0 ? i.path.map((seg) => String(seg)).join(".") : "(root)";
    return `${p}: ${i.message}`;
  });
  const more = issues.length > ISSUE_CAP ? ` (and ${issues.length - ISSUE_CAP} more)` : "";
  return shown.join("; ") + more;
}

const PASS_EXPECTED =
  `${MANIFEST_PATH} is a schema-valid ConsumerManifest whose identity, chart, per-env values files, ` +
  `and onboarding stage all satisfy the structure contract.`;

function reject(expected: string, found: string, reason: string): StructureOutcome {
  return {
    result: fail({ id: ID, title: TITLE, severity: SEVERITY, expected, found, reason }),
    manifest: null,
  };
}

export function checkStructure(input: StructureInput): StructureOutcome {
  const { files, targetName, stage } = input;
  const chartDir = normalizeDir(input.chartPath);
  const chartYamlPath = join(chartDir, "Chart.yaml");

  // ── 1. deploy/platform.yaml exists, parses, schema-validates ──────────────────────────────────
  const rawManifest = getFile(files, MANIFEST_PATH);
  if (rawManifest === undefined) {
    return reject(
      `${MANIFEST_PATH} must exist among the bundled files.`,
      `No ${MANIFEST_PATH} was found among the ${fileCount(files)} bundled file(s).`,
      `${MANIFEST_PATH} is the consumer manifest and the entry point of the contract; without it ` +
        `there is nothing to validate, so the plan is rejected.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(rawManifest);
  } catch (err) {
    return reject(
      `${MANIFEST_PATH} must be YAML that parses to a single ConsumerManifest object.`,
      `${MANIFEST_PATH} could not be parsed as YAML: ${cap(err instanceof Error ? err.message : String(err))}.`,
      `a manifest that does not parse cannot be validated against the consumer contract, so the ` +
        `plan is rejected.`,
    );
  }

  const validated = ConsumerManifestSchema.safeParse(parsed);
  if (!validated.success) {
    return reject(
      `${MANIFEST_PATH} must satisfy the ConsumerManifest schema (contract v1.3).`,
      `${MANIFEST_PATH} is not a valid ConsumerManifest: ${issueSummary(validated.error.issues)}.`,
      `the manifest violates the consumer-contract schema, so its declared shape cannot be trusted; ` +
        `fix the reported field(s).`,
    );
  }
  const manifest = validated.data;

  // ── 2. identity law: manifest.name == target, and Chart.yaml.name (if shipped) == manifest.name ─
  if (manifest.name !== targetName) {
    return reject(
      `The manifest name must equal the onboarding target name (identity law).`,
      `${MANIFEST_PATH} declares name "${cap(manifest.name)}" but the onboarding target is "${cap(targetName)}".`,
      `the identity law requires name == target == namespace == Chart.name; a mismatch would deploy ` +
        `the consumer under a name the platform did not authorize.`,
    );
  }

  const rawChartYaml = getFile(files, chartYamlPath);
  const chartYamlExists = rawChartYaml !== undefined;
  if (chartYamlExists) {
    const chartName = readNameField(rawChartYaml);
    if (chartName !== manifest.name) {
      return reject(
        `${chartYamlPath} name must equal the manifest name (identity law).`,
        `${MANIFEST_PATH} declares name "${cap(manifest.name)}" but ${chartYamlPath} declares ${nameDisplay(chartName)}.`,
        `the identity law requires the Helm chart name to equal the manifest name; a mismatch means ` +
          `the rendered release would not carry the authorized identity.`,
      );
    }
  }

  // ── 3. a declared chart must actually be in the bundle ────────────────────────────────────────
  if (manifest.chart && !chartYamlExists) {
    return reject(
      `${chartYamlPath} must exist when the manifest declares a chart.`,
      `${MANIFEST_PATH} declares chart.path "${cap(manifest.chart.path)}" but ${chartYamlPath} is not ` +
        `present among the bundled files.`,
      `a manifest that declares a chart must ship that chart; without ${chartYamlPath} the declared ` +
        `deploy cannot be rendered.`,
    );
  }

  // ── 4. every declared env has its base and per-env values overlay ─────────────────────────────
  // Gated on a declared chart: `chart` is optional (contract v1.3, shared/consumer.ts) — a build-only
  // manifest ships no chart and therefore no values files, so requiring them unconditionally would
  // reject every build-only manifest. When a chart IS declared, both the base values.yaml and the
  // per-env overlay are required for every declared env.
  if (manifest.chart) {
    const baseValues = join(chartDir, "values.yaml");
    for (const env of manifest.envs) {
      if (!has(files, baseValues)) {
        return reject(
          `${baseValues} and a values-<env>.yaml overlay must exist for every declared env.`,
          `Env "${env}" is declared but the base ${baseValues} is not present among the bundled files.`,
          `each declared env is rendered from the base values.yaml plus its per-env overlay; a missing ` +
            `base means no env can be rendered.`,
        );
      }
      const envValues = join(chartDir, `values-${env}.yaml`);
      if (!has(files, envValues)) {
        return reject(
          `${baseValues} and a values-<env>.yaml overlay must exist for every declared env.`,
          `Env "${env}" is declared but its overlay ${envValues} is not present among the bundled files.`,
          `each declared env needs its own values-${env}.yaml overlay; without it that env cannot be ` +
            `rendered from the chart.`,
        );
      }
    }
  }

  // ── 5. the onboarding stage must be a declared env ────────────────────────────────────────
  if (!(manifest.envs as readonly string[]).includes(stage)) {
    return reject(
      `The onboarding stage must be one of the manifest's declared envs (the declared-env rule).`,
      `The onboarding stage is "${cap(stage)}" but ${MANIFEST_PATH} declares envs [${manifest.envs.join(", ")}].`,
      `The stage being onboarded must be a declared env; a stage the manifest does not ` +
        `declare has no values overlay and no authorized target.`,
    );
  }

  const chartClause = manifest.chart
    ? ` the chart at ${chartYamlPath} is present with a matching name, its per-env values files exist,`
    : "";
  return {
    result: pass({
      id: ID,
      title: TITLE,
      severity: SEVERITY,
      expected: PASS_EXPECTED,
      found:
        `${MANIFEST_PATH} is a valid ConsumerManifest (name "${manifest.name}", envs ` +
        `[${manifest.envs.join(", ")}]); the identity law holds,${chartClause} and the onboarding ` +
        `stage "${stage}" is a declared env.`,
    }),
    manifest,
  };
}
