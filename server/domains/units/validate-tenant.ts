// The tenant (multi-app fan-out) validation core. The
// tenant analogue of validate.ts: it clones catalog@ref Manager-side, parses the fan-out
// manifest, takes the app catalog — a standing tenant's own, handed in by add-app, or the
// template's the apps repository declares, read here (app-catalog.ts) — resolves the fan-out
// (the standing members + the guid × apps[] matrix) at a THROWAWAY probe guid, renders every member
// INTO ITS OWN member namespace with the Manager's own HelmRenderer (the tenant charts are TRUSTED
// first-party charts, so there is no sandbox — the Manager renders them itself), and runs the T1..T4
// gates over the RenderedDocs. It composes one frozen TenantValidationReport whose verdict is a pass
// IFF every hard gate passed.
//
// This is PURE orchestration over the ports (RepoReader + HelmRenderer) and the pure fan-out algebra
// (resolveMembers / fanoutOf / memberNamespace) — no db, no executor, no timers — so it is exercised end-to-end
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
import { fanoutOf, identityProviderMember, memberNamespace, resolveMembers, type AppRef, type FanoutMember } from "./tenant-fanout.ts";
import { readAppCatalog } from "./app-catalog.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";
import { stageApex, tenantRecordName, tenantZone } from "#unit/shared/unit-host.ts";
import { catalogPinFile } from "../../../shared/pin.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { gateUnitHost } from "#unit/server/unit-host-gate.ts";
import type { StandingHostReader } from "#unit/server/unit-dns.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import type { TenantSpec } from "../../../shared/consumer.ts";
import { collectContainerImages } from "./ensure-images.ts";
import {
  TENANT_MANIFEST_PATH,
  gatePinnedSha,
  gateT1Manifest,
  gateT2Render,
  gateT3Isolation,
  gateT4Apps,
  composeTenantReport,
  type AppChoice,
  type MemberRender,
  type MemberDocs,
} from "./gates/tenant-gates.ts";
import type { GateResult } from "../../../shared/gates.ts";

/** What identifies a tenant validation: the catalog pin to validate + the fan-out shape to render
 *  (the same apps/stage the registration would carry). repoURL is always the catalog repo (a
 *  deployment constant supplied by the caller); credentialId opens the manager's first-party read
 *  credential for it. probeGuid is a THROWAWAY guid the members are rendered at — the render output is
 *  discarded, so it never collides with a live tenant. */
export interface ValidateTenantRequest {
  repoURL: string; // the catalog repo URL (a platform constant, supplied by the caller)
  ref: string; // the catalog branch/tag/sha to validate; resolved to the 40-char chartsRef pin
  stage: Stage;
  /** The apps and the selections each chose — T4 holds both against the app catalog. */
  apps: AppChoice[];
  probeGuid: string; // the throwaway guid the fan-out is rendered at
  /** The subdomain the tenant stands on — the members render at `<member>.<subdomain>.<stage apex>`
   *  (tenant.zone), so the validation holds the hosts the deploy will serve. */
  subdomain: string;
  /** The IdP's user boot-seed flag the registration will carry; delivered to the members like the deploy does. */
  seedUsers?: boolean;
  /** The tenant's own apps bundle as the registration will carry it: the flat build name the engines
   *  mount and the immutable image tag of its last release. Delivered under `tenant:` like the
   *  deploy does, so the render yields the bundle's image ref and ensure-images probes it. Absent
   *  for a tenant without one, which is delivered as the empty pair the registration carries then;
   *  it reaches no engine, because the plan derives a bundle for every tenant with an app
   *  (create-tenant.run.ts) and renders it at the placeholder until the run has built it. */
  appsImage?: string | undefined;
  appsImageTag?: string | undefined;
  /** The target cluster's values chain off its install branch. The tenant appsets layer exactly
   *  this chain onto every member chart at deploy, and the charts require values from it
   *  (example-lib.image reads global.endpoints.registry.host, the auth host composes from
   *  global.unitApex) — a render without it fails at T2 before any gate can judge the chart. */
  clusterValueFiles: readonly ClusterValueFile[];
  credentialId?: string; // the manager's first-party catalog read credential
  /** The target cluster's FQDN, given by the one caller that will WRITE the tenant's wildcard
   *  `*.<subdomain>.<stage apex>` (create-tenant's plan). Present ⇒ gate G27 reads the zone under
   *  that wildcard against the installation's clusters before the run writes anything. Absent for
   *  add-app and the post-build re-render, which write no record: the wildcard already stands. */
  clusterFqdn?: string;
}

export interface ValidateTenantDeps {
  repo: RepoReader;
  helm: HelmRenderer;
  /** Gate-line sink -> events rows (append-only). Called once per gate + once for the clone. */
  log: (line: string) => void;
  signal: AbortSignal;
  /** Report timestamps; injected so tests are deterministic. Defaults to Date.now. */
  now?: () => number;
  /** G27's input (unit-dns.ts standingHostFrom). Absent where the Manager has no DNS provider: G27
   *  then fails the plan, where provision-dns would have failed at step eight after the Vault entry,
   *  the bucket, the key, the AppProjects and the admission policies were written. */
  standingHost?: StandingHostReader;
}

export interface TenantValidationOutcome {
  verdict: "pass" | "fail";
  resolvedSha: string; // == the report's chartsRef (the fan-out pin)
  report: TenantValidationReport; // the frozen T1..T4 + G9 report (renders through the same gate card)
  /** Every container/initContainer `image:` across the rendered members (deduped + sorted) — the
   *  raw material of the ensure-images gate: the planner filters it to the target cluster's registrations
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
  /** The fan-out spec T1 parsed — what the plan reads `buildRepos` off; null where T1 could not read one. */
  spec: TenantSpec | null;
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

/** The requested apps as the fan-out needs them: each with the database list its catalog entry
 *  declares, which fills the `{databases}` token. An app the catalog does not name gets none — T4
 *  refuses it below, and until then it renders as the chart's own files say. */
function withDatabases(apps: readonly AppChoice[], catalog: AppsManifest): AppRef[] {
  const byName = new Map(catalog.apps.map((a) => [a.name, a]));
  return apps.map((a) => {
    const databases = byName.get(a.name)?.databases;
    return databases ? { name: a.name, databases } : { name: a.name };
  });
}

/** Every source's extra value files held against the checkout: a file the chart directory does not
 *  carry is dropped, and said. ArgoCD's `ignoreMissingValueFiles: true` skips such a file at deploy
 *  (hostyour-cloud tenants-appset.yaml) while `helm template -f` fails on it, so this is where the
 *  render and the deploy are made to agree — and the registration then records only files that
 *  stand, because the records returned here are what it carries. */
async function layerExistingValueFiles(members: TenantMemberRecord[], deps: ValidateTenantDeps, workdir: string): Promise<TenantMemberRecord[]> {
  const out: TenantMemberRecord[] = [];
  for (const m of members) {
    const sources: TenantMemberRecord["sources"] = [];
    for (const s of m.sources) {
      const valueFiles: string[] = [];
      for (const file of s.valueFiles) {
        if ((await deps.repo.readFile(workdir, `${s.chart}/${file}`)) !== null) valueFiles.push(file);
        else deps.log(`${s.chart}/${file} is absent in the catalog checkout — not layered on ${m.name} (the deploy skips a missing value file the same way)`);
      }
      sources.push({ ...s, valueFiles });
    }
    out.push({ ...m, sources });
  }
  return out;
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
      // own facts (guid, subdomain, stage, member, appName, apps, seedUsers, suspended, quiesced,
      // appsImage, appsImageTag),
      // which every source gets and each chart uses what it needs.
      // The app catalog first: what the apps repository's manifest declares fills the fan-out
      // (`{databases}`) and is what T4 holds the request against — the template's, for a new tenant
      // and for an app added to a standing one alike. A stand-in is said in the log.
      const catalog = await readAppCatalog({
        spec: t1.spec,
        catalog: { repo: deps.repo, workdir: cloned.workdir, ...(req.credentialId ? { credentialId: req.credentialId } : {}) },
        warn: deps.log,
        signal: deps.signal,
      });
      memberRecords = await layerExistingValueFiles(resolveMembers(t1.spec, withDatabases(req.apps, catalog)), deps, cloned.workdir);
      identityProvider = identityProviderMember(t1.spec);
      const members = fanoutOf(memberRecords, req.stage);
      resolvedMembers = members.map((m) => m.name);

      // Render each member at the probe guid, INTO ITS OWN member namespace. The guid reaches the
      // charts via .Release.Name / .Release.Namespace (releaseName "<guid>-<render>", namespace
      // "<guid>-<member>") — the exact naming the tenant appsets use — so validation renders what the
      // cluster deploys without guessing a values key, and T3 can hold each member to its own
      // namespace. The target cluster's chain rides every render as the folded override, and OVER IT
      // the values the tenants ApplicationSet delivers to every member at deploy
      // (hostyour-cloud clusters/argocd/files/tenants-appset.yaml, valuesObject): the tenant's own
      // facts and the zone it stands under, composed by the one host law (plugins/unit/shared/unit-host.ts). The
      // charts switch their tenant mode on `tenant.guid` and require `tenant.zone` and
      // `global.stageApex` there, so a render without these proves a mode the cluster never deploys
      // (hostyour-manager#137). OVER ALL OF IT the source's own values, resolved off the product's
      // manifest (`{app}` filled, `{databases}` filled) — the appset renders them last for the same
      // member, so a product key it sets is judged here as it is deployed. A helm failure is DATA on
      // the result, never a throw (helm port contract).
      const chainValues = foldChain(req.clusterValueFiles);
      const unitApex = unitApexFromChain(req.clusterValueFiles);
      const deliveredTo = (member: FanoutMember): Record<string, unknown> => ({
        tenant: {
          guid: req.probeGuid,
          member: member.member,
          appName: member.member,
          subdomain: req.subdomain,
          stage: req.stage,
          zone: tenantZone(req.subdomain, req.stage, unitApex),
          // The four tenant flags, under tenant: where every member chart reads them (the off
          // rendering, the identity provider's per-app roles and user seed, the engine's seed tiers)
          // and where the tenants ApplicationSet delivers them.
          suspended: false,
          quiesced: false,
          seedUsers: req.seedUsers ?? false,
          apps: req.apps,
          // The tenant's own bundle, or the empty pair — always both keys, as the registration
          // always carries both and the appset reads them bare.
          appsImage: req.appsImage ?? "",
          appsImageTag: req.appsImageTag ?? "",
        },
        global: { stageApex: stageApex(unitApex, req.stage) },
      });
      const renders: MemberRender[] = [];
      const docsByMember: MemberDocs[] = [];
      for (const member of members) {
        if (deps.signal.aborted) throw abortError();
        const namespace = memberNamespace(req.probeGuid, member.member, req.stage);
        // THE INSTALLATION'S OWN PIN OVER THE CHART, exactly as the tenants ApplicationSet layers
        // `$pins/<chart>/pins-<stage>.yaml` off the books branch this clone is (hostyour-cloud
        // clusters/argocd/files/tenants-appset.yaml): the tag the cluster pulls, never the trunk's
        // product default — so the images this render yields, which ensure-images probes and the
        // run freezes, are the ones the fan-out deploys. Absent while no release of this
        // installation has built the chart's images (the appset's ignoreMissingValueFiles); the
        // trunk default then stands and the image gate names it as missing (#154).
        const pin = catalogPinFile(req.stage);
        const pinned = (await deps.repo.readFile(cloned.workdir, `${member.chart}/${pin}`)) !== null;
        const result = await deps.helm.template({
          workdir: cloned.workdir,
          chartPath: member.chart,
          valueFiles: pinned ? [...member.valueFiles, pin] : member.valueFiles,
          valuesObject: mergeDeep(mergeDeep(chainValues, deliveredTo(member)), member.values),
          releaseName: `${req.probeGuid}-${member.name}`,
          namespace,
          signal: deps.signal, // a DELETE/budget abort kills the in-flight helm child immediately
        });
        renders.push({ member: member.name, result });
        if (result.ok) docsByMember.push({ member: member.name, namespace, guid: req.probeGuid, docs: result.docs });
        deps.log(`rendered ${member.name} (${member.chart}) into ${namespace} -> ${result.ok ? `${result.docs.length} doc(s)` : "FAILED"}`);
      }

      const renderedMembers = renders.filter((r) => r.result.ok).map((r) => r.member);
      // The ensure-images raw material: every container image the rendered fan-out pulls. Collected
      // here — the ONE place the rendered docs exist — and surfaced on the outcome for the planner.
      images = collectContainerImages(docsByMember.flatMap((m) => m.docs));
      const t2 = gateT2Render(renders);
      const t3 = gateT3Isolation(docsByMember);
      const t4 = gateT4Apps({ apps: req.apps, members, renderedMembers, standingMembers: t1.spec.members.map((m) => m.name), catalog });
      for (const g of [t2, t3, t4]) {
        gates.push(g);
        streamGate(deps, g);
      }
      appsValidated = req.apps.map((a) => a.name);
      // G27 reads the ZONE under the tenant's record — the wildcard or the zone itself, as the
      // product's routing names it (tenantRecordName) — the one obstacle the render gates cannot
      // see, and the one that used to stop create-tenant at provision-dns with the crypto entry,
      // the bucket and the key already written. Same gate, same four readings as the consumer's.
      if (req.clusterFqdn !== undefined) {
        const host = tenantRecordName(t1.spec.routing, req.subdomain, req.stage, unitApex);
        const standing = deps.standingHost ? await deps.standingHost(host, req.clusterFqdn) : null;
        const g27 = gateUnitHost({ host, unitName: req.probeGuid, clusterFqdn: req.clusterFqdn, standing });
        gates.push(g27);
        streamGate(deps, g27);
      }
    }

    // G9 pinned SHA — chartsRef pins an immutable 40-char catalog commit, never a moving branch,
    // so every generated member Application deploys exactly the package these gates judged.
    const pinnedSha = gatePinnedSha(cloned.resolvedSha);
    gates.push(pinnedSha);
    streamGate(deps, pinnedSha);

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
    return { verdict: report.verdict, resolvedSha: cloned.resolvedSha, report, images, memberRecords, identityProvider, spec: t1.spec ?? null };
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}
