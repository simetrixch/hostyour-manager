// The tenant (multi-app fan-out) validation core. The
// tenant analogue of validate.ts: it clones catalog@ref Controller-side, parses the fan-out
// manifest, resolves the fan-out (the trio + the guid × apps[] matrix) at a THROWAWAY probe guid,
// renders every member INTO ITS OWN member namespace with the Controller's own HelmRenderer (the tenant
// charts are TRUSTED first-party charts, so there is no sandbox — the Controller renders them itself),
// and runs the T1..T4 gates over the RenderedDocs. It composes one frozen
// TenantValidationReport whose verdict is a pass IFF every hard gate passed.
//
// This is PURE orchestration over the ports (RepoReader + HelmRenderer) and the pure fan-out algebra
// (resolveFanout / memberNamespace) — no db, no executor, no timers — so it is exercised end-to-end
// against the fakes and is safe to call more than once for the same ref. It streams each gate to the
// log sink as it lands, mirroring validate.ts.
//
// Boundary: a domain module. It depends only on the git + helm PORTS (never their impls) and the pure
// domain fan-out module; the pointer write (TenantEntry) is the create-tenant record step's job, not
// this function's — it returns only the verdict + the frozen report.
import { parse as parseYaml } from "yaml";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { HelmRenderer } from "../../adapters/helm/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { identityProviderMember, memberNamespace, resolveFanout, resolveMembers, type AppRef } from "./tenant-fanout.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import { collectContainerImages } from "./ensure-images.ts";
import {
  TENANT_MANIFEST_PATH,
  gateG9,
  gateT1Manifest,
  gateT2Render,
  gateT3Isolation,
  gateT4Apps,
  composeTenantReport,
  type MemberRender,
  type MemberDocs,
} from "./gates/tenant-gates.ts";
import type { GateResult } from "../../../shared/gates.ts";

/** What identifies a tenant validation: the catalog pin to validate + the fan-out shape to render
 *  (the same apps/stage the registration would carry). repoURL is always the catalog repo (a
 *  deployment constant supplied by the caller); credentialId opens the controller's first-party read
 *  credential for it. probeGuid is a THROWAWAY guid the members are rendered at — the render output is
 *  discarded, so it never collides with a live tenant. */
export interface ValidateTenantRequest {
  repoURL: string; // the catalog repo URL (a platform constant, supplied by the caller)
  ref: string; // the catalog branch/tag/sha to validate; resolved to the 40-char chartsRef pin
  stage: Stage;
  apps: AppRef[];
  probeGuid: string; // the throwaway guid the fan-out is rendered at
  /** The target cluster's values chain off its install branch. The tenant appsets layer exactly
   *  this chain onto every member chart at deploy, and the charts require values from it
   *  (example-lib.image reads global.endpoints.registry.host, the auth host composes from
   *  global.unitApex) — a render without it fails at T2 before any gate can judge the chart. */
  clusterValueFiles: readonly ClusterValueFile[];
  credentialId?: string; // the controller's first-party catalog read credential
}

export interface ValidateTenantDeps {
  repo: RepoReader;
  helm: HelmRenderer;
  /** Gate-line sink -> events rows (append-only). Called once per gate + once for the clone. */
  log: (line: string) => void;
  signal: AbortSignal;
  /** Report timestamps; injected so tests are deterministic. Defaults to Date.now. */
  now?: () => number;
}

export interface TenantValidationOutcome {
  verdict: "pass" | "fail";
  resolvedSha: string; // == the report's chartsRef (the fan-out pin)
  report: TenantValidationReport; // the frozen T1..T4 + G9 report (renders through the same gate card)
  /** Every container/initContainer `image:` across the rendered members (deduped + sorted) — the
   *  raw material of the ensure-images gate: the planner filters it to the target cluster's registry
   *  host (requiredImagesFrom) and freezes the result into the run params. Kept OFF the report
   *  (the shared report schema + its hash stay untouched); this is plan-time plumbing, not audit. */
  images: string[];
  /** EVERY member this tenant gets — the product's standing members plus one per requested app —
   *  resolved against the manifest read at validation time, and which of them is the IdP. Frozen onto
   *  the outcome for the same reason chartsRef is: the plan is approved against THIS manifest, and the
   *  run records what it was approved with. Empty when T1 could not read a spec, in which case the
   *  verdict is already a fail. */
  memberRecords: TenantMemberRecord[];
  identityProvider: string;
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Later wins; objects merge key-wise, everything else replaces — helm's own layering rule. */
function mergeDeep(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isRecord(prev) && isRecord(value) ? mergeDeep(prev, value) : value;
  }
  return out;
}

/** Fold the cluster chain into ONE override object for the member renders. The chain files live in
 *  the platform repo while the member charts live in the cloned catalog workdir, so they
 *  cannot ride as -f files; folded in chain order and layered LAST (the helm port's valuesObject),
 *  the result reproduces the appsets' layering because the chain states only `global.*` keys and no
 *  member chart states any — the one relative position that could differ (a chart overriding a
 *  platform file's key) therefore has no key it could differ on. */
function foldChain(files: readonly ClusterValueFile[]): Record<string, unknown> {
  let folded: Record<string, unknown> = {};
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    if (isRecord(parsed)) folded = mergeDeep(folded, parsed);
  }
  return folded;
}

/** Stream a gate to the sink exactly like validate.ts's pollToDone does for the sandbox gates. */
function streamGate(deps: ValidateTenantDeps, g: GateResult): void {
  deps.log(`${g.id} ${g.status} — ${g.detail}`);
}

/** Clone catalog@ref -> parse the fan-out manifest -> resolve + render the fan-out at the probe
 *  guid -> run T1..T4 -> compose. Throws only on a clone/access failure (the caller records it as a
 *  preflight rejection); a gate failure returns verdict "fail" with the full composed report so the
 *  operator sees every expected/found/reason. */
export async function validateTenant(req: ValidateTenantRequest, deps: ValidateTenantDeps): Promise<TenantValidationOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const cloned = await deps.repo.cloneAtRef({
    repoURL: req.repoURL,
    ref: req.ref,
    ...(req.credentialId ? { credentialId: req.credentialId } : {}),
    signal: deps.signal,
  });
  deps.log(`cloned ${req.repoURL} @ ${req.ref} -> ${cloned.resolvedSha}`);
  try {
    const rawManifest = await deps.repo.readFile(cloned.workdir, TENANT_MANIFEST_PATH);
    const t1 = gateT1Manifest(rawManifest);
    const gates: GateResult[] = [t1.result];
    streamGate(deps, t1.result);

    let appsValidated: string[] = [];
    let resolvedMembers: string[] = [];
    let images: string[] = [];
    let memberRecords: TenantMemberRecord[] = [];
    let identityProvider = "";

    if (t1.spec) {
      // RESOLVED, not just named: the ApplicationSet generator reads the registration and nothing
      // else, so every field it needs to render a member has to be in it. The charts, the extra value
      // files and the values are the PRODUCT's, copied out of its manifest with only `{app}` filled
      // in — the platform composes none of them. What the appset adds at render time is the tenant's
      // own facts (guid, subdomain, stage, member, appName, apps, seedUsers, suspended, quiesced),
      // which every source gets and each chart uses what it needs.
      memberRecords = resolveMembers(t1.spec, req.apps);
      identityProvider = identityProviderMember(t1.spec);
      const members = resolveFanout(t1.spec, req.apps, req.stage);
      resolvedMembers = members.map((m) => m.name);

      // Render each member at the probe guid, INTO ITS OWN member namespace. The guid reaches the
      // charts via .Release.Name / .Release.Namespace (releaseName "<guid>-<render>", namespace
      // "<guid>-<member>") — the exact naming the tenant appsets use — so validation renders what the
      // cluster deploys without guessing a values key, and T3 can hold each member to its own
      // namespace. The target cluster's chain rides every render as the folded override, the same
      // values the appsets layer at deploy. A helm failure is DATA on the result, never a throw
      // (helm port contract).
      const chainValues = foldChain(req.clusterValueFiles);
      const renders: MemberRender[] = [];
      const docsByMember: MemberDocs[] = [];
      for (const member of members) {
        if (deps.signal.aborted) throw abortError();
        const namespace = memberNamespace(req.probeGuid, member.member);
        const result = await deps.helm.template({
          workdir: cloned.workdir,
          chartPath: member.chart,
          valueFiles: member.valueFiles,
          valuesObject: chainValues,
          releaseName: `${req.probeGuid}-${member.name}`,
          namespace,
          signal: deps.signal, // a DELETE/budget abort kills the in-flight helm child immediately
        });
        renders.push({ member: member.name, result });
        if (result.ok) docsByMember.push({ member: member.name, namespace, docs: result.docs });
        deps.log(`rendered ${member.name} (${member.chart}) into ${namespace} -> ${result.ok ? `${result.docs.length} doc(s)` : "FAILED"}`);
      }

      const renderedMembers = renders.filter((r) => r.result.ok).map((r) => r.member);
      // The ensure-images raw material: every container image the rendered fan-out pulls. Collected
      // here — the ONE place the rendered docs exist — and surfaced on the outcome for the planner.
      images = collectContainerImages(docsByMember.flatMap((m) => m.docs));
      const t2 = gateT2Render(renders);
      const t3 = gateT3Isolation(docsByMember);
      const t4 = gateT4Apps({ apps: req.apps, members, renderedMembers, standingMembers: t1.spec.members.map((m) => m.name) });
      for (const g of [t2, t3, t4]) {
        gates.push(g);
        streamGate(deps, g);
      }
      appsValidated = req.apps.map((a) => a.name);
    }

    // G9 pinned SHA — chartsRef pins an immutable 40-char catalog commit, never a moving branch,
    // so every generated member Application deploys exactly the package these gates judged.
    const g9 = gateG9(cloned.resolvedSha);
    gates.push(g9);
    streamGate(deps, g9);

    const report = composeTenantReport({
      resolvedSha: cloned.resolvedSha,
      probeGuid: req.probeGuid,
      appsValidated,
      resolvedMembers,
      startedAt,
      finishedAt: now(),
      manifest: t1.manifest,
      gates,
    });
    return { verdict: report.verdict, resolvedSha: cloned.resolvedSha, report, images, memberRecords, identityProvider };
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}
