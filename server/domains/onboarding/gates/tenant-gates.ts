// The tenant (multi-app fan-out) gates + report assembler.
// The tenant analogue of the consumer G-gates: unlike the consumer path — where an UNTRUSTED
// chart is rendered inside the credential-free gate-runner sandbox — the tenant fan-out renders TRUSTED
// first-party charts from catalog, so the Controller renders them ITSELF (adapters/helm) and
// runs these T1..T4 gates over the RenderedDocs. Each gate authors its own expected/found/reason
// (reason null IFF pass), carries a T-id that fits the widened /^[GT][0-9]{1,2}$/, and produces the
// exact GateResult shape the consumer gates do — so composeTenantReport's report renders through the
// existing gate card in the web UI with zero fork.
//
// The gates:
//   T1 manifest   — deploy/platform.yaml parses + validates as a ConsumerManifest that carries a
//                   tenant: fan-out block — a fan-out repo never carries its own chart.
//   T2 render     — every resolveFanout member templated cleanly (a helm failure is DATA, not a throw).
//   T3 isolation  — the KIND-SCOPE FENCE, applied PER MEMBER against that member's OWN namespace.
//                   Controller render bypasses the sandbox, so this faithfully replicates the sandbox
//                   kind-whitelist proof: the ONLY cluster-scoped kind a tenant chart may emit is
//                   Namespace; any other cluster-scoped kind, any Application/ApplicationSet/AppProject,
//                   any Role/RoleBinding, or any inline Secret — including one smuggled inside a
//                   List/aggregate — FAILS, as does a document pinned to a namespace other than the
//                   member's own, a SIBLING member of the same tenant included. The List/items expansion
//                   mirrors gate-runner/src/render-docs.ts (the applier flattens ANY object with a
//                   top-level items[], kind-agnostic), reimplemented here.
//   T4 apps       — every apps[] entry resolved to its rendered engine+front render set, with no
//                   reserved-name collision and no duplicate app name (a belt behind the schema refine).
//
// Boundary: a domain module. Imports only shared/ (isomorphic) + the helm port; node:crypto
// is permitted here (the domain authors the whole report, so it — not a runner — hashes it).
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { hardGatesPass, reportHashPayload, type GateResult, type GateEvidence } from "../../../../shared/gates.ts";
import { ConsumerManifestSchema, type ConsumerManifest, type TenantSpec } from "../../../../shared/consumer.ts";
import { TenantValidationReportSchema, type TenantValidationReport } from "../../../../shared/tenant.ts";
import type { RenderedDoc, HelmRenderResult } from "../../../adapters/helm/port.ts";
import type { FanoutMember, AppRef } from "../tenant-fanout.ts";

export const TENANT_MANIFEST_PATH = "deploy/platform.yaml";
const TEXT_CAP = 200; // cap any echoed untrusted string (a parse error, a helm stderr, a chart name)
const ISSUE_CAP = 6; // keep the schema-issue summary bounded for a hostile manifest

function cap(text: unknown): string {
  const s = typeof text === "string" ? text : String(text);
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s;
}

/** Evidence values are schema-capped at 256 chars; clip so a hostile value cannot bust the cap. */
function clip(s: string): string {
  return s.length > 256 ? s.slice(0, 256) : s;
}

/** One-line summary of the first few zod issues. Structurally typed so no zod value import is needed. */
function issueSummary(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const shown = issues.slice(0, ISSUE_CAP).map((i) => {
    const p = i.path.length > 0 ? i.path.map((seg) => String(seg)).join(".") : "(root)";
    return `${p}: ${i.message}`;
  });
  const more = issues.length > ISSUE_CAP ? ` (and ${issues.length - ISSUE_CAP} more)` : "";
  return shown.join("; ") + more;
}

// ── T1 manifest ────────────────────────────────────────────────────────────────────────────────

/** The T1 outcome: the gate result plus what the later gates need (the parsed manifest for the report,
 *  and the tenant fan-out spec resolveFanout renders against). spec is non-null IFF the gate passed. */
export interface TenantManifestOutcome {
  result: GateResult;
  manifest: ConsumerManifest | null;
  spec: TenantSpec | null;
}

const T1_EXPECTED =
  `${TENANT_MANIFEST_PATH} exists, parses as YAML, validates as a ConsumerManifest, and declares a ` +
  `tenant: fan-out block (a fan-out repo, contract v1.3).`;

function t1Reject(found: string, reason: string): TenantManifestOutcome {
  return {
    result: { id: "T1", title: "manifest", severity: "hard", status: "fail", expected: T1_EXPECTED, found, reason, detail: "manifest rejected" },
    manifest: null, spec: null,
  };
}

/** T1 — parse + validate catalog's deploy/platform.yaml into a ConsumerManifest that carries a
 *  tenant: fan-out block. The manifest bytes are UNTRUSTED input (a mis-committed deploy repo), so each
 *  step is guarded and fails closed. A manifest with NO tenant: block is not a fan-out repo — there is
 *  nothing to fan out — so it is rejected here even though it may be a schema-valid consumer manifest. */
export function gateT1Manifest(rawManifest: string | null): TenantManifestOutcome {
  if (rawManifest === null) {
    return t1Reject(
      `No ${TENANT_MANIFEST_PATH} was found in the catalog checkout.`,
      `${TENANT_MANIFEST_PATH} is the fan-out manifest and the entry point of the tenant contract; without it there is nothing to validate, so the plan is rejected.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(rawManifest);
  } catch (err) {
    return t1Reject(
      `${TENANT_MANIFEST_PATH} could not be parsed as YAML: ${cap(err instanceof Error ? err.message : String(err))}.`,
      `a manifest that does not parse cannot be validated against the consumer contract, so the plan is rejected.`,
    );
  }
  const validated = ConsumerManifestSchema.safeParse(parsed);
  if (!validated.success) {
    return t1Reject(
      `${TENANT_MANIFEST_PATH} is not a valid ConsumerManifest: ${issueSummary(validated.error.issues)}.`,
      `the manifest violates the consumer-contract schema, so its declared shape cannot be trusted; fix the reported field(s).`,
    );
  }
  const manifest = validated.data;
  if (!manifest.tenant) {
    return t1Reject(
      `${TENANT_MANIFEST_PATH} validates as a ConsumerManifest (name "${cap(manifest.name)}") but declares no tenant: fan-out block.`,
      `a tenant is validated by fanning out its tenant: block; a manifest without one is not a fan-out repo, so there is nothing to render, and the plan is rejected.`,
    );
  }
  return {
    result: {
      id: "T1", title: "manifest", severity: "hard", status: "pass", expected: T1_EXPECTED,
      found:
        `${TENANT_MANIFEST_PATH} is a valid ConsumerManifest (name "${manifest.name}") that declares a tenant: ` +
        `fan-out block (trio + per-app charts).`,
      reason: null, detail: "manifest ok",
    },
    manifest, spec: manifest.tenant,
  };
}

// ── T2 render ──────────────────────────────────────────────────────────────────────────────────

/** One fan-out member's render outcome, tagged with its member name for the expected/found/reason sentences. */
export interface MemberRender {
  member: string;
  result: HelmRenderResult;
}

/** T2 — every resolveFanout member rendered cleanly. A helm failure is DATA ({ok:false, error}), never
 *  a throw (helm port contract), so this reports the FIRST broken member with helm's own stderr. */
export function gateT2Render(renders: readonly MemberRender[]): GateResult {
  const expected =
    `every resolved fan-out render (the trio auth/jobs/report + per-app engine/front) renders cleanly ` +
    `with helm template against the catalog charts.`;
  for (const r of renders) {
    if (!r.result.ok) {
      return {
        id: "T2", title: "render", severity: "hard", status: "fail",
        expected,
        found: `fan-out member "${r.member}" failed to render: ${cap(r.result.error)}.`,
        reason: `a member that does not render cannot be validated or deployed; the plan is rejected so a broken tenant chart never reaches the cluster.`,
        detail: "a member failed to render",
        evidence: [{ source: "rendered", name: r.member, value: clip(r.result.error) }],
      };
    }
  }
  return {
    id: "T2", title: "render", severity: "hard", status: "pass",
    expected,
    found: `all ${renders.length} fan-out member(s) rendered cleanly with helm template.`,
    reason: null, detail: "all members rendered",
  };
}

// ── T3 isolation (the kind-scope fence) ──────────────────────────────────────────────────────────

// Cluster-scoped kinds a tenant chart must NEVER emit. Namespace is the ONE permitted at cluster scope
// (a member chart may declare its own namespace). The tenant's crypto entry is written
// by the Controller, so a chart emitting one would be a second writer of the same object — it is
// rejected below by name rather than left to fall through this list.
const CLUSTER_SCOPED_FORBIDDEN = new Set<string>([
  "Node", "PersistentVolume", "StorageClass", "ClusterRole", "ClusterRoleBinding",
  "CustomResourceDefinition", "PriorityClass", "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration", "APIService", "IngressClass", "RuntimeClass",
  "ClusterIssuer", "ClusterSecretStore", "ClusterExternalSecret",
  "Tenant", // the Controller provisions it (create-tenant); a chart-rendered twin would fight it
]);
// Namespaced control-plane kinds a tenant chart may not mint for itself (it does not own the GitOps
// layer — the Controller generates the fan-out Applications, never a chart).
const ARGO_KINDS = new Set<string>(["Application", "ApplicationSet", "AppProject"]);
const RBAC_ROLE_KINDS = new Set<string>(["Role", "RoleBinding"]);

/** One rejection carrying everything the result text and the evidence row need. kind/name override the
 *  doc's own when the violation was found inside an expanded List item. */
interface Violation {
  found: string;
  reason: string;
  fieldPath: string;
  value: string;
  kind?: string;
  name?: string;
}

/** A plain (non-array) object, or null. Untrusted values flow through this before any field read. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** metadata.name off an untrusted object, or "" when absent/non-string. */
function nameOf(raw: Record<string, unknown> | null): string {
  const md = raw ? asRecord(raw.metadata) : null;
  const n = md ? md.name : undefined;
  return typeof n === "string" ? n : "";
}

/** metadata.namespace off an untrusted object, or "" when absent/non-string. A cluster-scoped object
 *  has none; a namespaced object confined to its member carries <guid>-<member>. */
function namespaceOf(raw: Record<string, unknown> | null): string {
  const md = raw ? asRecord(raw.metadata) : null;
  const ns = md ? md.namespace : undefined;
  return typeof ns === "string" ? ns : "";
}

/** Evaluate one object's kind against the fence. A List/*List aggregate (ANY object with a top-level
 *  items[] array — kind-agnostic, the applier's unstructured.IsList rule) is expanded and each item is
 *  checked the same way, so a forbidden member cannot hide inside a wrapper the top-level walk skips. */
function evaluate(kind: string, name: string, raw: Record<string, unknown> | null, where: string, memberNs: string): Violation | null {
  const listItems = raw ? raw.items : undefined;
  if (Array.isArray(listItems)) {
    for (let i = 0; i < listItems.length; i++) {
      const item = asRecord(listItems[i]);
      if (!item) continue;
      const itemKind = typeof item.kind === "string" ? item.kind : "";
      if (itemKind === "") continue;
      const itemName = nameOf(item);
      const v = evaluate(itemKind, itemName, item, `item #${i} of ${kind || "aggregate"} "${name}" (${where})`, memberNs);
      if (v) return { ...v, fieldPath: `items[${i}].${v.fieldPath}`, kind: v.kind ?? itemKind, name: v.name ?? itemName };
    }
    return null;
  }
  // Namespace confinement: a doc that declares an explicit metadata.namespace outside the MEMBER's own
  // <guid>-<member> escapes the fence (helm --namespace only defaults the namespace for objects that
  // omit it, so an object hard-coding another namespace slips past a kind-only check). A sibling member
  // of the same tenant is just as much outside — each member is self-contained, and the member's
  // AppProject permits its own namespace and no other. Cluster-scoped kinds carry no namespace and fall
  // through to the kind checks below (Namespace alone is permitted).
  const ns = namespaceOf(raw);
  if (ns !== "" && ns !== memberNs) {
    return {
      found: `${where} has kind "${kind}", named "${name}", pinned to namespace "${ns}".`,
      reason: `a rendered object declares metadata.namespace "${ns}", outside the member namespace "${memberNs}" — it escapes the member's namespace confinement.`,
      fieldPath: "metadata.namespace", value: ns,
    };
  }
  if (CLUSTER_SCOPED_FORBIDDEN.has(kind)) {
    return {
      found: `${where} has kind "${kind}", named "${name}".`,
      reason: `kind "${kind}" is cluster-scoped; the ONLY cluster-scoped kind a tenant chart may emit is Namespace, so this escapes the member's namespace fence.`,
      fieldPath: "kind", value: kind,
    };
  }
  if (ARGO_KINDS.has(kind)) {
    return {
      found: `${where} has kind "${kind}", named "${name}".`,
      reason: `kind "${kind}" is an argoproj.io control resource; a tenant chart may not mint its own ArgoCD Application/ApplicationSet/AppProject — the Controller generates the fan-out.`,
      fieldPath: "kind", value: kind,
    };
  }
  if (RBAC_ROLE_KINDS.has(kind)) {
    return {
      found: `${where} has kind "${kind}", named "${name}".`,
      reason: `kind "${kind}" is an RBAC role resource; a tenant chart may not grant itself Role/RoleBinding permissions.`,
      fieldPath: "kind", value: kind,
    };
  }
  if (kind === "Secret") {
    return {
      found: `${where} has kind "Secret", named "${name}".`,
      reason: `an inline "Secret" is forbidden; tenant secrets are provisioned from Vault via ExternalSecret, never rendered into the chart output.`,
      fieldPath: "kind", value: kind,
    };
  }
  return null;
}

/** All rendered docs of one fan-out render, tagged with its name for the expected/found/reason sentences and with the
 *  MEMBER namespace those docs were rendered into — the fence T3 holds them to. The engine and front
 *  renders of one app carry the same `namespace`, because they deploy into the one member namespace. */
export interface MemberDocs {
  member: string;
  namespace: string;
  docs: readonly RenderedDoc[];
}

/** T3 — the kind-scope fence over every rendered member's docs, each judged against ITS OWN member
 *  namespace. Returns the FIRST violation across all members (a fail-closed scan), with an evidence row
 *  locating the offending kind. */
export function gateT3Isolation(docsByMember: readonly MemberDocs[]): GateResult {
  const namespaces = [...new Set(docsByMember.map((m) => m.namespace))];
  const expected =
    `no rendered document escapes its MEMBER's namespace fence: every namespaced object is confined to ` +
    `the namespace its own member deploys into (${namespaces.join(", ") || "none"}), a sibling member of ` +
    `the same tenant included; the only cluster-scoped kind permitted is Namespace; no ` +
    `Application/ApplicationSet/AppProject, no Role/RoleBinding, no inline Secret, with List aggregates ` +
    `expanded.`;
  let total = 0;
  for (const m of docsByMember) {
    for (let i = 0; i < m.docs.length; i++) {
      const doc = m.docs[i];
      if (!doc) continue;
      total++;
      const v = evaluate(doc.kind, doc.name, asRecord(doc.raw), `member "${m.member}" document #${i}`, m.namespace);
      if (v) {
        const evidence: GateEvidence[] = [
          { source: "rendered", kind: v.kind ?? doc.kind, name: v.name ?? doc.name, fieldPath: v.fieldPath, value: clip(v.value) },
        ];
        return {
          id: "T3", title: "isolation", severity: "hard", status: "fail",
          expected, found: v.found, reason: v.reason, detail: "a document escaped the namespace fence", evidence,
        };
      }
    }
  }
  return {
    id: "T3", title: "isolation", severity: "hard", status: "pass",
    expected,
    found: `all ${total} rendered document(s) stay inside their own member's namespace fence across ${namespaces.length} member namespace(s): no forbidden cluster-scoped, control-plane, RBAC, or inline-Secret kind (List aggregates expanded).`,
    reason: null, detail: "namespace fence held",
  };
}

// ── T4 apps ──────────────────────────────────────────────────────────────────────────────────────

/** What T4 checks: the requested apps[] against the resolved + rendered render set. */
export interface AppsCheckInput {
  apps: readonly AppRef[];
  members: readonly FanoutMember[];
  renderedMembers: readonly string[]; // render names that rendered ok (T2)
  standingMembers: readonly string[]; // the members the product declares for every tenant (TenantSpec.members)
}

const T4_EXPECTED =
  `every requested app resolves to its own member's engine+front renders and both render, with no ` +
  `reserved-name collision and no duplicate app name (RESERVED_APP_NAMES).`;

function t4Reject(found: string, reason: string): GateResult {
  return {
    id: "T4", title: "apps", severity: "hard", status: "fail", expected: T4_EXPECTED,
    found, reason, detail: "apps did not resolve", evidence: [{ source: "controller", value: clip(found) }],
  };
}

/** T4 — every apps[] entry resolved to a rendered engine+front render set, reserved names never
 *  collide, and no app name repeats. A belt behind TenantRegistrationSchema's refine: validation renders
 *  exactly the guid × apps[] matrix the appset deploys, so a request that would collide or leave an
 *  app un-rendered is rejected before a registration is written. */
export function gateT4Apps(input: AppsCheckInput): GateResult {
  const rendered = new Set(input.renderedMembers);
  const seen = new Set<string>();
  for (const app of input.apps) {
    // Against the standing members THIS product declares, never a constant set of names.
    if (input.standingMembers.includes(app.name)) {
      return t4Reject(
        `app "${cap(app.name)}" is also a standing member of this tenant.`,
        `the standing member and the app are both named <guid>-${cap(app.name)}, so the app would claim the member's own namespace and its Application <guid>-${cap(app.name)}-<stage> and silently overwrite it; the plan is rejected.`,
      );
    }
    if (seen.has(app.name)) {
      return t4Reject(
        `app "${cap(app.name)}" appears more than once in apps[].`,
        `each member is keyed by app name; a duplicate would collide on the namespace <guid>-${cap(app.name)}, so the plan is rejected.`,
      );
    }
    seen.add(app.name);
    const perApp = input.members.filter((m) => m.member === app.name).map((m) => m.name);
    if (perApp.length === 0) {
      return t4Reject(
        `app "${cap(app.name)}" resolved to no fan-out renders.`,
        `an app must resolve to its engine + front renders to be deployable; with none there is nothing to render or deploy, so the plan is rejected.`,
      );
    }
    for (const memberName of perApp) {
      if (!rendered.has(memberName)) {
        return t4Reject(
          `app "${cap(app.name)}" render "${cap(memberName)}" did not render.`,
          `every resolved per-app render must succeed for the app to be validated; one that did not leaves the app half-deployed, so the plan is rejected.`,
        );
      }
    }
  }
  return {
    id: "T4", title: "apps", severity: "hard", status: "pass", expected: T4_EXPECTED,
    found: `all ${input.apps.length} requested app(s) resolved to their rendered engine+front renders with no reserved-name collision and no duplicate.`,
    reason: null, detail: "apps resolved",
  };
}

/** G9 pinned SHA — the tenant's chartsRef pins an immutable catalog commit, never a moving
 *  branch: every member Application of the fan-out is generated at that revision, so a branch here
 *  would let the rendered package drift away from the one these gates judged. It keeps its G-id
 *  because the report card, the id grammar and the result shape are the same across both gate sets. */
export function gateG9(resolvedSha: string): GateResult {
  const ok = /^[0-9a-f]{40}$/.test(resolvedSha);
  return {
    id: "G9",
    title: "pinned SHA",
    severity: "hard",
    status: ok ? "pass" : "fail",
    expected: "the requested chartsRef resolves to a 40-character hex commit SHA, which every generated member Application pins so the deployed package is immutable",
    found: `resolved revision: ${resolvedSha}`,
    reason: ok ? null : "a fan-out must pin an immutable commit SHA, never a moving branch; the plan is rejected",
    detail: ok ? "pinned to a commit SHA" : "not a 40-char commit SHA",
    evidence: [{ source: "controller", value: resolvedSha.slice(0, 256) }],
  };
}

// ── report assembly ──────────────────────────────────────────────────────────────────────────────

/** The metadata composeTenantReport folds around the gates to form the frozen report. */
export interface TenantReportMeta {
  resolvedSha: string; // == chartsRef (the catalog fan-out pin)
  probeGuid: string; // the throwaway guid the members were rendered at
  appsValidated: string[]; // apps[] names whose per-app members were rendered
  resolvedMembers: string[]; // the resolved fan-out member identifiers
  startedAt: number;
  finishedAt: number;
  manifest: ConsumerManifest | null; // null <=> T1 failed
  gates: GateResult[];
}

/** Compose the frozen TenantValidationReport: recompute the verdict over all the gates (a pass IFF
 *  every HARD gate passed — the controller authors ALL the gates, so there is no separate runner/sandbox
 *  leg to fold in, unlike composeReport), hash the canonical body, and parse against the shared schema
 *  as a fail-closed belt. Pure aside from the sha256. Keeps .gates/.verdict so the report renders through
 *  the existing gate card unchanged; only the top-level metadata is fan-out-shaped. */
export function composeTenantReport(meta: TenantReportMeta): TenantValidationReport {
  const verdict: "pass" | "fail" = hardGatesPass(meta.gates) ? "pass" : "fail";
  const body = {
    resolvedSha: meta.resolvedSha,
    chartsRef: meta.resolvedSha,
    probeGuid: meta.probeGuid,
    appsValidated: meta.appsValidated,
    resolvedMembers: meta.resolvedMembers,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    manifest: meta.manifest,
    gates: meta.gates,
    verdict,
  };
  const reportHash = createHash("sha256").update(reportHashPayload(body)).digest("hex");
  return TenantValidationReportSchema.parse({ ...body, reportHash });
}
