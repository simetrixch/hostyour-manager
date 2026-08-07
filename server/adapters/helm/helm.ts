// The real HelmRenderer behind port.ts — the tenant validation engine.
// Shells `helm template` via execFile (an argv array, NEVER a shell, so a chart path or release
// name can never be interpreted by a shell) over a cloned catalog workdir, then flattens the
// multi-document YAML stream into RenderedDocs.
//
// The flatten mirrors the gate-runner's parseRenderedDocs (gate-runner/src/render-docs.ts),
// REIMPLEMENTED here rather than imported across the package boundary: ANY object carrying a
// top-level `items` ARRAY is expanded kind-agnostically (k8s/ArgoCD unstructured.IsList flattens
// such a wrapper on apply, so `kind: List`, `kind: Widget`, and a kind-less wrapper all count), so
// a smuggled member can never hide inside an aggregate past gateT3Isolation. Even though the tenant
// charts are trusted first-party charts, every field is read through typeof/Array.isArray guards and
// the recursion is bounded on depth + a per-document identity set — a scalar where an object is
// expected, or a self-referential anchor, degrades gracefully instead of crashing.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type { HelmRenderRequest, HelmRenderResult, HelmRenderer, RenderedDoc } from "./port.ts";

const execFileP = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024; // fail-closed cap on helm stdout
const RENDER_TIMEOUT_MS = 120_000; // kill a wedged helm rather than hang the validation
const MAX_DEPTH = 50; // bound List-wrapper recursion so a pathological chart cannot exhaust the stack

// --- flatten technique, ported from gate-runner/src/render-docs.ts ---

/** A plain (non-array) object, or null. Every untrusted value flows through this before any field
 *  read, so a string/array/number/null where an object is expected collapses to null (never throws). */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** metadata.<field> off an object, or "" when metadata is absent / not an object / not a string. */
function metaString(obj: Record<string, unknown>, field: "name" | "namespace"): string {
  const md = asRecord(obj.metadata);
  const value = md ? md[field] : undefined;
  return typeof value === "string" ? value : "";
}

/** Expand one parsed value into `out`. A null/empty/non-object/array value is skipped, as is any
 *  object without a string `kind`. An aggregate carrying an array `items` is unwrapped (each item
 *  re-enters here; the wrapper itself is never emitted); anything else is emitted as a RenderedDoc. */
function expand(node: unknown, out: RenderedDoc[], depth: number, seen: Set<object>): void {
  if (depth > MAX_DEPTH) return;
  const obj = asRecord(node);
  if (obj === null) return; // null / empty / non-object / array document
  if (seen.has(obj)) return; // cyclic anchor guard

  // Applier rule (unstructured.IsList): ANY object with a top-level `items` ARRAY is flattened into
  // its items on apply, KIND-AGNOSTIC — so unwrap it here regardless of kind (or an absent kind).
  // Check items BEFORE the kind guard so a `kind: Widget` / kind-less wrapper cannot carry a member
  // past a gate that only walks the top level.
  const items = obj.items;
  if (Array.isArray(items)) {
    seen.add(obj);
    for (const item of items) expand(item, out, depth + 1, seen);
    return; // never emit the aggregate wrapper itself
  }

  const kind = typeof obj.kind === "string" ? obj.kind : "";
  if (kind === "") return; // no items and no kind — not a deployable Kubernetes object

  out.push({
    apiVersion: typeof obj.apiVersion === "string" ? obj.apiVersion : "",
    kind,
    name: metaString(obj, "name"),
    namespace: metaString(obj, "namespace"),
    raw: obj,
  });
}

/**
 * Parse the multi-document YAML stream from `helm template` into a flat list of RenderedDocs, with
 * every List/aggregate recursively expanded so no member can hide inside it. Exported so the tenant
 * gate tests exercise the flatten/parse mapping directly (the live helm shell is integration-tested).
 *
 * Fail-closed: an unparseable stream, a document that cannot be materialised (e.g. an alias bomb
 * that trips yaml's maxAliasCount), or any odd shape yields fewer/no docs rather than throwing.
 */
export function parseHelmDocs(yamlStream: string): RenderedDoc[] {
  const out: RenderedDoc[] = [];
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(yamlStream);
  } catch {
    return out;
  }
  for (const doc of documents) {
    let js: unknown;
    try {
      js = doc.toJS(); // resolves aliases; an alias bomb throws here and is treated as "no document"
    } catch {
      continue;
    }
    expand(js, out, 0, new Set<object>());
  }
  return out;
}

// --- the adapter ---

/** Build the `helm template` argv. valueFiles are CHART-relative (the ArgoCD Helm-source semantics:
 *  a source's valueFiles resolve against its `path`), so each is JOINED onto chartPath here — the
 *  execFile cwd is the REPO root (the cloned catalog workdir), and a bare `-f values.yaml`
 *  would resolve there and fail with helm's "open values.yaml: no such file or directory" for every
 *  fan-out member (confirmed live against the deployed controller: T1 pass, every render FAILED).
 *  `overrideFile` is the staged valuesObject temp file, layered LAST (highest precedence).
 *  --include-crds so the validator renders EXACTLY what ArgoCD deploys: ArgoCD renders Helm sources
 *  with CRDs included (helm.skipCrds=false by default), but plain `helm template` omits crds/, so
 *  without it a chart's crds/ content (applied verbatim by helm) would deploy unvalidated.
 *  Exported for unit tests — the chartPath join is load-bearing. */
export function helmTemplateArgs(req: HelmRenderRequest, overrideFile?: string): string[] {
  const valueArgs: string[] = [];
  for (const f of req.valueFiles) valueArgs.push("-f", join(req.chartPath, f));
  if (overrideFile !== undefined) valueArgs.push("-f", overrideFile);
  return ["template", req.releaseName, req.chartPath, "--namespace", req.namespace, "--include-crds", ...valueArgs];
}

export class HelmCliRenderer implements HelmRenderer {
  async template(req: HelmRenderRequest): Promise<HelmRenderResult> {
    let overrideDir: string | undefined;
    try {
      let overrideFile: string | undefined;
      if (req.valuesObject !== undefined) {
        overrideDir = await mkdtemp(join(tmpdir(), "example-helm-"));
        overrideFile = join(overrideDir, "override.yaml");
        await writeFile(overrideFile, stringifyYaml(req.valuesObject), "utf8");
      }
      const args = helmTemplateArgs(req, overrideFile);
      let stdout: string;
      try {
        ({ stdout } = await execFileP("helm", args, {
          cwd: req.workdir,
          maxBuffer: MAX_BUFFER,
          timeout: RENDER_TIMEOUT_MS,
          windowsHide: true,
          ...(req.signal ? { signal: req.signal } : {}),
        }));
      } catch (e) {
        return { ok: false, error: helmError(e) };
      }
      return { ok: true, docs: parseHelmDocs(stdout) };
    } catch (e) {
      // A throw from mkdtemp / writeFile / stringifyYaml (e.g. a circular valuesObject yaml cannot
      // serialise) must NOT escape — the renderer's contract is to return {ok:false}, never throw,
      // so a single bad tenant spec can never crash the streaming planner mid fan-out.
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `helm render preparation failed: ${reason.slice(0, 800)}` };
    } finally {
      if (overrideDir !== undefined) await rm(overrideDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

/** Turn an execFile failure into a single-line render error carrying helm's own stderr (verbatim,
 *  capped) — a missing binary and a timeout get their own honest messages. */
function helmError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer; killed?: boolean };
  if (err.code === "ENOENT") return "helm template failed: the helm binary was not found on PATH";
  if (err.killed) return `helm template exceeded the ${RENDER_TIMEOUT_MS}ms budget`;
  const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : "";
  const reason = stderr.trim() || err.message || "unknown error";
  return `helm template failed: ${reason.slice(0, 800)}`;
}
