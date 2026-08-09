// gate-runner/src/render-docs.ts
// The security belt every rendered-doc gate sits on top of. `helm template` emits a
// multi-document YAML stream; a hostile chart can hide a forbidden object (a Namespace, an inline
// Secret, a NodePort Service) INSIDE an aggregate — ANY object carrying a top-level `items` array,
// because Kubernetes and ArgoCD expand such a wrapper into its `items[]` on apply (unstructured.
// IsList — the kind name is irrelevant, so `kind: Widget` or a kind-less wrapper flattens too). This
// module parses the stream and FLATTENS every aggregate recursively, so each smuggled member is
// emitted as its own RenderedDoc and can never slip past a gate that only walks the top level. Every
// field is read through
// typeof/Array.isArray guards — the parsed YAML is fully untrusted, so a string where an object is
// expected, an alias bomb, or a self-referential anchor must degrade gracefully, never crash.
import { parseAllDocuments } from "yaml";
import type { RenderedDoc } from "./gates/gate.ts";

// The recursion is bounded on two independent axes so a pathological chart cannot exhaust the stack:
// a hard depth cap on nested List wrappers, and a per-document identity set that stops a cyclic
// anchor (an item that references an ancestor List) from looping forever.
const MAX_DEPTH = 50;

/** A plain (non-array) object, or null. Every untrusted value flows through this before any field
 *  read, so a string/array/number/null where an object is expected collapses to null (never throws). */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** metadata.<field> off an untrusted object, or "" when metadata is absent / not an object / the
 *  field is not a string (a hostile chart may put a scalar where metadata belongs). */
function metaString(obj: Record<string, unknown>, field: "name" | "namespace"): string {
  const md = asRecord(obj.metadata);
  const value = md ? md[field] : undefined;
  return typeof value === "string" ? value : "";
}

/** Expand one parsed value into `out`. A null/empty/non-object/array value is skipped, as is any
 *  object without a string `kind`. A List/*List aggregate that carries an array `items` is unwrapped
 *  (each item re-enters this function; the wrapper itself is never emitted); anything else is emitted
 *  as a RenderedDoc whose docIndex is its position in the flattened output. */
function expand(node: unknown, env: string, out: RenderedDoc[], depth: number, seen: Set<object>): void {
  if (depth > MAX_DEPTH) return;
  const obj = asRecord(node);
  if (obj === null) return; // null / empty / non-object / array document
  if (seen.has(obj)) return; // cyclic anchor guard

  // Applier rule (k8s/ArgoCD unstructured.IsList): ANY object carrying a top-level `items` ARRAY is
  // flattened into its items on apply, KIND-AGNOSTIC — so unwrap it here regardless of kind (or an
  // absent kind). Keying on a "*List" kind name instead would let a `kind: Widget` (or kind-less)
  // wrapper carry a Namespace/Secret/NodePort in items past every rendered-doc gate while ArgoCD
  // deploys them. Check items BEFORE the kind guard for exactly that reason.
  const items = obj.items;
  if (Array.isArray(items)) {
    seen.add(obj);
    for (const item of items) {
      expand(item, env, out, depth + 1, seen);
    }
    return; // never emit the aggregate wrapper itself
  }

  const kind = typeof obj.kind === "string" ? obj.kind : "";
  if (kind === "") return; // no items and no kind — not a deployable Kubernetes object

  out.push({
    env,
    docIndex: out.length,
    apiVersion: typeof obj.apiVersion === "string" ? obj.apiVersion : "",
    kind,
    name: metaString(obj, "name"),
    namespace: metaString(obj, "namespace"),
    raw: obj,
  });
}

/**
 * Parse the multi-document YAML stream from `helm template` into a flat list of RenderedDocs, with
 * every `kind: List` / `*List` aggregate recursively expanded so no member can hide inside it.
 *
 * Fail-closed by construction: an unparseable stream, a document that cannot be materialised (e.g. an
 * alias bomb that trips yaml's maxAliasCount), or any hostile shape yields fewer/no docs rather than
 * throwing — a gate can only reject what it can see, so surfacing less is always the safe direction.
 */
export function parseRenderedDocs(yamlStream: string, env: string): RenderedDoc[] {
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
      // toJS resolves aliases here; yaml's default maxAliasCount throws on an alias bomb, which we
      // treat as "this document does not exist" rather than letting it take the whole job down.
      js = doc.toJS();
    } catch {
      continue;
    }
    expand(js, env, out, 0, new Set<object>());
  }
  return out;
}
