// TenantRegistrations — the Manager's ONLY writer of the catalog
// repo's registrations/**. The structural twin of the consumer registration Registrations (registrations.ts),
// reusing the SAME laws through registrations.ts's shared primitives (serializePointer / parseRegistration /
// makeRegistrationGuard / trailer):
//   - PATH GUARD: every write path matches registrations/<guid>/<stage>.yaml exactly — a traversal or
//     a stray path is a programming error (INTERNAL), never a commit.
//   - SERIALIZE -> VALIDATE -> RE-PARSE: the file is schema-validated, serialized as flat
//     "key: <json>" YAML, and the bytes are re-parsed + re-validated (anti-injection, deep-equal).
//   - RUN-ID TRAILER: every commit ends with [<runId>], traceable to an approved+succeeded Run.
//   - STAGE BOUNDARY: a registration for stage X may only name a cluster MARKED X. Enforced here, at
//     the one writer, against clusters/active/<fqdn>.yaml on the platform repo — the same guard
//     commitRegistration applies to a consumer.
//
// ONE FILE per tenant per stage: registrations/<guid>/<stage>.yaml. The guid is the DIRECTORY and the
// stage is the FILE NAME, so the path IS the identity and the body repeats neither. Every field of
// TenantRegistrationSchema is written on EVERY commit, which is what makes the read-modify-write ops
// below safe: a field a writer does not re-emit is silently dropped from the file, and a dropped
// cluster would mis-target a LIVE tenant's fan-out (prune+selfHeal cascade). The round-trip tests pin
// that symmetry. The gate report is NOT written to catalog — it lives in the run record / DB
// (the RunDetail gate card renders it from there).
//
// Suspend is a FIELD flip (the chart renders the off state), NOT a git-mv. removeTenant git-rm's the
// tenant's file for that stage (offboard).
//
// Boundary: domain layer — imports shared/ (type + schema), the inventory domain's cluster marking
import type { UnitQuota } from "../../../shared/unit-size.ts";
// (the base domain every other one may read) and the git PlatformRepo port; the concrete second repo
// bound to catalog (its workRoot + repo-qualified lock) is wired by the adapter.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { guid as guidSchema, TenantRegistrationSchema, type TenantMemberRecord, type TenantRegistration } from "../../../shared/tenant.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
// The scan's skipped-registration shape is a WIRE shape: the orphan scan (tenant-orphans.ts) hands these
// to the browser verbatim, so it is declared once in shared/api-types.ts and used here rather than
// declared here and mirrored there — see that file's tenants section for what a mirror cost us.
import type { SkippedTenantPointerView } from "../../../shared/api-types.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import type { BranchScope, PlatformRepo } from "../../adapters/git/port.ts";
import { AppError } from "../../kernel/errors.ts";
import { serializePointer, makeRegistrationGuard, trailer, type ClusterStageResolver, assertClusterStage } from "./registrations.ts";

/** The branch catalog's member CHARTS are read at — the trunk, because a chart is product: the
 *  same twenty charts serve every tenant of every installation, and the app-type catalog and the
 *  manager-side render both want the current tip.
 *
 *  This is NOT where a tenant REGISTRATION goes. That is installation state and stands on this
 *  installation's books branch (`repo.booksBranch` below, shared/branches.ts) — the two were one
 *  constant, and one constant meant that moving the registrations off the trunk would have taken the
 *  charts with them, silently, and every member render would have followed a branch nothing
 *  maintains. Two names, so a reader cannot conflate them again. */
export const CATALOG_CHART_BRANCH = PRODUCT_BRANCH;

/** registrations/<guid>/<stage>.yaml — the ONE per-tenant-per-stage file. The guid segment mirrors
 *  shared/tenant.ts:guid (12 chars of Crockford base32 minus i/l/o/u). */
const TENANT_REGISTRATION_GUARD = /^registrations\/[0-9a-hjkmnp-tv-z]{12}\/(dev|test|prod)\.yaml$/;

const guard = makeRegistrationGuard(TENANT_REGISTRATION_GUARD, "registrations/<guid>/<stage>.yaml");

/** The directory every stage file of ONE tenant stands in. */
const tenantDir = (guid: string): string => `registrations/${guid}`;

/** registrations/<guid>/<stage>.yaml — the path of ONE tenant registration. */
const registrationPath = (stage: Stage, guid: string): string => `${tenantDir(guid)}/${stage}.yaml`;

/** WHY a YAML parse failed, in one line. Shared by the strict fold and the tolerant scan so a broken
 *  file reads identically whether it THREW the read or was SKIPPED by it. */
const yamlWhy = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** WHY a body failed its schema, as "path message; path message". Same sharing reason as yamlWhy. */
const schemaWhy = (err: z.ZodError): string => err.issues.map((i) => i.path.join(".") + " " + i.message).join("; ");

/** ONE tenant as the TOLERANT scan sees it: the registration fields a DISCOVERY (the orphan scan) or a
 *  REMOVAL (tenant-purge / the replace, via tenant-replace.ts) needs. `guid`/`stage` come from the PATH
 *  — the body carries neither, so the two can never disagree. */
export interface ScannedTenant {
  guid: string;
  subdomain: string;
  stage: Stage;
  cluster: string;
  apps: { name: string; seedReference: boolean; seedDemo: boolean }[];
  /** The standing members this tenant was created with, off its own registration — what a teardown
   *  deletes one AppProject per. Read from the file rather than assumed, so a scan of a tenant of any
   *  product names the members that tenant actually has. */
  members: string[];
}

/** The three HONEST outcomes of reading ONE tenant registration, kept apart because the callers act
 *  differently on each: "absent" is the only one that means "there is nothing here" (a resumed removal
 *  skips on it), while "unreadable" means a file DOES stand at that path — its body just cannot be
 *  trusted, so a removal must still git-rm it by path and a scan must still report it. */
export type TenantScan =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | { status: "read"; entry: ScannedTenant };

export interface TenantRead {
  entry: TenantRegistration;
}

/** The write set for ONE tenant registration — a single file, serialized through the shared
 *  serialize -> validate -> re-parse round-trip. Exported for the domain steps + tests. */
export function tenantRegistrationWrite(stage: Stage, guid: string, registration: TenantRegistration): { path: string; content: string } {
  return { path: guard(registrationPath(stage, guid)), content: serializePointer(TenantRegistrationSchema, registration) };
}

export class TenantRegistrations {
  /** `repo` is catalog (where the registrations live); `clusterStage` resolves a cluster's
   *  MARKED stage off the platform repo — a different repo, which is why it rides as a function rather
   *  than a second PlatformRepo this class would then also be tempted to write through. */
  constructor(
    private readonly repo: PlatformRepo,
    private readonly clusterStage: ClusterStageResolver,
  ) {}

  /** The branch every read and every commit below stands on — this installation's books in
   *  catalog, resolved once when the repo port was built, and the same name hostyour-cloud's
   *  books carry (one installation, one books branch, in both repositories). Exposed for the
   *  git-branch LOCK every tenant run claims: keyed on anything but the branch actually written, the
   *  lock serializes nothing. */
  get branch(): string {
    return this.repo.booksBranch;
  }

  /** Read ONE tenant's registration for a stage, or null if not onboarded. The file is written by this
   *  registrations's flat "key: <json>" serializer, which is a SUBSET of YAML, so it is read with a real
   *  YAML parser — a hand-corrected file with comments or block-style lists still folds. */
  async readTenant(stage: Stage, guid: string): Promise<TenantRead | null> {
    const path = registrationPath(stage, guid);
    const raw = await this.repo.withBranch(this.branch, (books) => books.readFile(path));
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw new AppError("INTERNAL", `tenant registration ${path} is not valid YAML: ${yamlWhy(e)}`);
    }
    const r = TenantRegistrationSchema.safeParse(parsed);
    if (!r.success) throw new AppError("INTERNAL", `tenant registration ${path} failed its schema: ${schemaWhy(r.error)}`);
    return { entry: r.data };
  }

  /** The ONE read of ONE registrations/<guid>/<stage>.yaml — the single implementation behind BOTH the
   *  stage-wide scan and the per-guid scanTenant, so "what does this registration say" cannot drift into
   *  two answers. TOLERANT where readTenant is strict: a body it cannot trust yields "unreadable" WITH
   *  the reason rather than a throw, because a scan must wedge neither a fresh onboard nor an orphan
   *  removal on one broken tenant, and a skipped registration that nobody hears about is a lie
   *  (SkippedTenantPointerView). */
  private async scanTenantDir(books: BranchScope, stage: Stage, guid: string): Promise<TenantScan> {
    const path = registrationPath(stage, guid);
    const raw = await books.readFile(path);
    if (raw === null) return { status: "absent" };
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      return { status: "unreadable", reason: `${path} is not valid YAML: ${yamlWhy(e)}` };
    }
    const r = TenantRegistrationSchema.safeParse(parsed);
    if (!r.success) return { status: "unreadable", reason: `${path} failed its schema: ${schemaWhy(r.error)}` };
    return { status: "read", entry: { guid, stage, subdomain: r.data.subdomain, cluster: r.data.cluster, apps: r.data.apps, members: r.data.members.map((m) => m.name) } };
  }

  /** The ONE scan of the registrations at a stage: scanTenantDir over every guid directory, bucketed
   *  into what it COULD read and what it could not. A guid directory that carries no file for THIS
   *  stage is simply absent from both buckets — the tenant lives at another stage. Every public scan
   *  below is a thin projection of this, so "which tenants are deployed at this stage" has a SINGLE
   *  implementation. A directory whose name is not a guid is skipped WITH its reason: it stands inside
   *  the very tree the appsets generate from, so an operator must see it. */
  private async scanTenantStage(stage: Stage): Promise<{ found: ScannedTenant[]; skipped: SkippedTenantPointerView[] }> {
    return this.repo.withBranch(this.branch, async (books) => {
      const found: ScannedTenant[] = [];
      const skipped: SkippedTenantPointerView[] = [];
      for (const g of await books.listDir("registrations")) {
        if (!guidSchema.safeParse(g).success) {
          skipped.push({ guid: g, stage, reason: `registrations/${g} is not a <guid> directory` });
          continue;
        }
        const scan = await this.scanTenantDir(books, stage, g);
        if (scan.status === "read") found.push(scan.entry);
        else if (scan.status === "unreadable") skipped.push({ guid: g, stage, reason: scan.reason });
      }
      return { found, skipped };
    });
  }

  /** ONE guid's registration, read with the SCAN's tolerance — the read every REMOVAL resolves through
   *  (tenant-replace.ts:resolveTeardownTarget, and the teardown's own "already removed?" check). It is
   *  deliberately NOT readTenant: that one THROWS on a body it cannot parse, so a tenant with a drifted
   *  file could be LISTED by the scan and yet never planned for removal — it would fail identically
   *  forever, and it would also block re-creating that subdomain (resolveReplaceTargets resolves every
   *  same-subdomain guid). The removal path honours exactly the tolerance the scan does, because it is
   *  the same code. */
  async scanTenant(stage: Stage, guid: string): Promise<TenantScan> {
    return this.repo.withBranch(this.branch, (books) => this.scanTenantDir(books, stage, guid));
  }

  /** Every guid DEPLOYED at this stage, read from the GitOps registrations alone — the discovery source
   *  the row-keyed run kinds cannot provide: an ORPHAN has a live registration and NO
   *  tenants row, so scanning git is the only way to NAME it at all (and a tenant-purge is keyed on the
   *  guid). Unfiltered by design; the caller decides what to do with a guid it does not know. The guids
   *  it could NOT read are the orphan scan's business — listTenantPointers carries those out. */
  async listTenantGuids(stage: Stage): Promise<string[]> {
    return (await this.scanTenantStage(stage)).found.map((t) => t.guid);
  }

  /** Every DEPLOYED tenant at this stage AND every registration the scan had to skip — the SAME scan as
   *  listTenantGuids, carrying what the ORPHAN scan needs to make what it found actionable
   *  actionable: the `subdomain` an operator recognises a tenant by (a bare guid names
   *  nothing to a human), and the ArgoCD-registered slave name `cluster`, which is the only way to
   *  resolve an orphan's target cluster row (resolveClusterIdByName) — there is no tenants row to read
   *  a clusterId from, and a tenant-purge cannot be aimed without one. `skipped` rides along because
   *  the caller renders "N registrations could not be read": swallowing it here would turn a scan that
   *  read nothing into the sentence "every deployed tenant has a matching inventory row". */
  async listTenantPointers(stage: Stage): Promise<{ pointers: ScannedTenant[]; skipped: SkippedTenantPointerView[] }> {
    const { found, skipped } = await this.scanTenantStage(stage);
    return { pointers: found, skipped };
  }

  /** Every guid whose registration carries `subdomain` — the same scan, filtered. The create-tenant
   *  idempotent-by-subdomain replace unions this with the DB inventory so it catches ORPHANS
   *  deployed-but-never-recorded: a live registration with no row. */
  async subdomainGuids(stage: Stage, subdomain: string): Promise<string[]> {
    return (await this.scanTenantStage(stage)).found.filter((t) => t.subdomain === subdomain).map((t) => t.guid);
  }

  /** Every subdomain a tenant stands at, ACROSS ALL STAGES — the set the consumer onboarding's G23
   *  holds a candidate unit name against, because a consumer named after one would serve exactly the
   *  host that tenant's IdP scopes its session cookies to (unit-dns.ts). Stage-free deliberately:
   *  neither the cookie Domain nor the consumer's host carries a stage, and two clusters may share
   *  one `global.unitApex`, so a stage-scoped answer would miss a collision the browser does not. */
  async listTenantSubdomains(): Promise<string[]> {
    const subdomains = new Set<string>();
    for (const stage of STAGE) {
      for (const t of (await this.scanTenantStage(stage)).found) subdomains.add(t.subdomain);
    }
    return [...subdomains];
  }

  /** Commit ONE tenant's registration for ONE stage (create-tenant). The stage boundary is enforced
   *  HERE, at the writer: the named cluster's own marking must say this stage, or nothing is written.
   *  Overwrite-idempotent on resume. */
  async commitTenant(input: { stage: Stage; guid: string; registration: TenantRegistration; runId: string }): Promise<{ commit: string }> {
    const { stage, guid, registration, runId } = input;
    await assertClusterStage(this.clusterStage, registration.cluster, stage, `tenant ${guid}`);
    return this.repo.withBranch(this.branch, (books) =>
      books.commit({
        message: `create-tenant(${guid}): ${stage} on ${registration.cluster} + ${registration.apps.length} app(s) ${trailer(runId)}`,
        write: [tenantRegistrationWrite(stage, guid, registration)],
      }),
    );
  }

  /** Read-modify-write the apps[] matrix: append or drop one app. Reserved names + duplicates are
   *  refused with a clear VALIDATION error (the guard the schema's superRefine provides at write time,
   *  raised here so the operator sees it before a commit is attempted). add-app / remove-app. */
  async updateTenantApps(stage: Stage, guid: string, input: { op: "append" | "drop"; app: string; member?: TenantMemberRecord; seedReference?: boolean; seedDemo?: boolean; runId: string }): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    const { op, app, member, seedReference = false, seedDemo = false, runId } = input;
    const has = current.entry.apps.some((a) => a.name === app);
    if (op === "append" && has) throw new AppError("VALIDATION", `app "${app}" already exists in tenant "${guid}"`);
    // Held against THIS tenant's own members, not against a constant: both are named <guid>-<name>,
    // so the app would claim the member's namespace, AppProject and Application.
    if (op === "append" && current.entry.members.some((m) => m.name === app)) {
      throw new AppError("VALIDATION", `app name "${app}" is also a member of tenant "${guid}" — both are named <guid>-${app}, so the app would claim the member's namespace and Application`);
    }
    if (op === "drop" && !has) throw new AppError("VALIDATION", `app "${app}" is not in tenant "${guid}"`);
    if (op === "append" && !member) throw new AppError("VALIDATION", `add-app for "${app}" carries no member record — the ApplicationSet fans out over members[], so the app would be recorded as owned and never deployed`);
    // A later-added app carries its seed tiers too into the registration's apps[] entry, and its
    // MEMBER into members[] — the two lists move together, which the schema then holds them to.
    const apps = op === "append" ? [...current.entry.apps, { name: app, seedReference, seedDemo }] : current.entry.apps.filter((a) => a.name !== app);
    const members = op === "append" ? [...current.entry.members, member!] : current.entry.members.filter((m) => m.name !== app);
    const runKind = op === "append" ? "add-app" : "remove-app";
    const sign = op === "append" ? "+" : "-";
    return this.write(stage, guid, { ...current.entry, apps, members }, `${runKind}(${guid}): ${sign}${app} ${trailer(runId)}`);
  }

  /** Flip the tenant-wide suspended field — a FIELD flip, NOT a git-mv: the file stays at its one path,
   *  the Application keeps being generated, and the chart renders the off state (replicas 0, no
   *  Ingress). A prune-based suspend would be destructive: the member charts render ServiceClaims whose
   *  deprovision finalizer drops the user AND the databases on ANY claim deletion, an ArgoCD prune
   *  included. tenant-suspend / tenant-resume. */
  async setTenantSuspended(stage: Stage, guid: string, suspended: boolean, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    const runKind = suspended ? "tenant-suspend" : "tenant-resume";
    return this.write(stage, guid, { ...current.entry, suspended }, `${runKind}(${guid}) ${trailer(runId)}`);
  }

  /** Flip the tenant-wide quiesced field — the deeper pause a relocation holds the tenant in while
   *  its stores are dumped: replicas 0 and no Ingress like a suspend, but machine-driven, so an
   *  operator's suspend and a run's quiesce cannot overwrite each other's intent (the same split the
   *  consumer registrations makes). Never a prune — the ServiceClaims survive, which is what keeps the
   *  databases reachable for the dump. */
  async setTenantQuiesced(stage: Stage, guid: string, quiesced: boolean, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    const runKind = quiesced ? "quiesce" : "unquiesce";
    return this.write(stage, guid, { ...current.entry, quiesced }, `${runKind}(${guid}) ${trailer(runId)}`);
  }

  /** Write the tenant's `quota` — the six figures that bound EVERY member namespace of it, resolved
   *  by the caller from the size table as it stands NOW. Named setQuota and not setSize because the
   *  registration carries figures, not a size name: what a cluster reads is what the unit gets.
   *
   *  One field of one file, like the flips above; writing the same figures commits nothing, so a
   *  re-apply whose numbers did not move leaves no history. tenant-set-size. */
  async setQuota(stage: Stage, guid: string, quota: UnitQuota, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, quota }, `size(${guid}) ${trailer(runId)}`);
  }

  /** Repoint the tenant's `cluster` field — the whole bracket moves at once: every member appset
   *  selects on this one field, so the source slave stops generating the fan-out and the target
   *  starts. The stage boundary holds here exactly as at commitTenant. */
  async setTenantCluster(stage: Stage, guid: string, cluster: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    await assertClusterStage(this.clusterStage, cluster, stage, `tenant ${guid}`);
    return this.write(stage, guid, { ...current.entry, cluster }, `tenant-migrate(${guid}): ${current.entry.cluster} -> ${cluster} ${trailer(runId)}`);
  }

  /** git rm the tenant's registration for ONE stage (tenant-offboard), and the whole guid directory's
   *  remaining sibling stages are untouched — a tenant offboarded at test stays live at prod. A second
   *  offboard (no file) is refused.
   *
   *  The refusal reads through the TOLERANT scan, never the strict fold: the removal is BY PATH (built
   *  from stage+guid, needing no body at all), so the ONE question this guard asks is "does a file stand
   *  here". A tenant whose registration has drifted is precisely the one an operator is purging, and
   *  throwing on the body would refuse to remove it — the guard would be protecting the leftover instead
   *  of the tenant. */
  async removeTenant(stage: Stage, guid: string, runId: string): Promise<{ commit: string }> {
    if ((await this.scanTenant(stage, guid)).status === "absent") {
      throw new AppError("VALIDATION", `tenant "${guid}" is not onboarded`);
    }
    return this.repo.withBranch(this.branch, (books) =>
      books.commit({
        message: `tenant-offboard(${guid}): ${stage} ${trailer(runId)}`,
        remove: [guard(registrationPath(stage, guid))],
      }),
    );
  }

  /** Rewrite the whole registration file from a complete entry. Every read-modify-write op above goes
   *  through here with `{ ...current.entry, <patch> }`, so a field can never be dropped by a partial
   *  rewrite — the file is always the full schema. */
  private async write(stage: Stage, guid: string, registration: TenantRegistration, message: string): Promise<{ commit: string }> {
    return this.repo.withBranch(this.branch, (books) =>
      books.commit({ message, write: [tenantRegistrationWrite(stage, guid, registration)] }),
    );
  }
}
