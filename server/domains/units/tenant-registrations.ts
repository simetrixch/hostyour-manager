import { readOnlyPlatformRepo } from "../../adapters/git/port.ts";
// TenantRegistrations — the Manager's ONLY writer of the deploy
// repository's registrations/**. The structural twin of the consumer registration Registrations (registrations.ts),
// reusing the SAME laws through the shared primitives of registration-laws.ts (serializePointer / parseRegistration /
// makeRegistrationGuard / trailer):
//   - PATH GUARD: every write path matches registrations/<guid>/<stage>.yaml exactly — a traversal or
//     a stray path is a programming error (INTERNAL), never a commit.
//   - SERIALIZE -> VALIDATE -> RE-PARSE: the file is schema-validated, serialized as flat
//     "key: <json>" YAML, and the bytes are re-parsed + re-validated (anti-injection, deep-equal).
//   - RUN-ID TRAILER: every commit ends with [<runId>], traceable to an approved+succeeded Run.
//
// ONE FILE per tenant per stage: registrations/<guid>/<stage>.yaml. The guid is the DIRECTORY and the
// stage is the FILE NAME, so the path IS the identity and the body repeats neither. The stage is the
// tenant's own, and the `cluster` field names the machine that stage stands on, which serves that stage
// (resolveTenantCluster), so the stages of one guid stand on machines of their own. Every field of
// TenantRegistrationSchema is written on EVERY commit, which is what makes the read-modify-write ops
// below safe: a field a writer does not re-emit is silently dropped from the file, and a dropped
// cluster would mis-target a LIVE tenant's fan-out (prune+selfHeal cascade). The round-trip tests pin
// that symmetry. The gate report is NOT written to the deploy repository — it lives in the run record / DB
// (the RunDetail gate card renders it from there).
//
// Suspend is a FIELD flip (the chart renders the off state), NOT a git-mv. removeTenant git-rm's the
// tenant's file for that stage (offboard).
//
// Boundary: domain layer — imports shared/ (type + schema) and the git PlatformRepo port; the
// concrete second repo bound to the deploy repository (its workRoot + repo-qualified lock) is wired by the adapter.
import type { UnitQuota, UnitSize } from "#unit/shared/unit-size.ts";
import { parse as parseYaml } from "yaml";
import { guid as guidSchema, TenantRegistrationSchema, type TenantMemberRecord, type TenantRegistration, type TenantWebsite } from "../../../shared/tenant.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
// The scan's skipped-registration shape is a WIRE shape: the orphan scan (tenant-orphans.ts) hands these
// to the browser verbatim, so it is declared once in shared/api-types.ts and used here rather than
// declared here and mirrored there — see that file's tenants section for what a mirror costs.
import type { SkippedTenantPointerView } from "../../../shared/api-types.ts";
import type { BranchScope, PlatformRepo } from "../../adapters/git/port.ts";
import { errInternal, errValidation } from "../../kernel/errors.ts";
import { serializePointer, makeRegistrationGuard, trailer, schemaWhy } from "#unit/server/registration-laws.ts";
import { withAppDatabases } from "./tenant-fanout.ts";
import { applyDomainChanges, type DomainChange } from "../../../shared/domain-move.ts";

/** registrations/<guid>/<stage>.yaml — the ONE per-tenant-per-stage file. The guid segment mirrors
 *  shared/tenant.ts:guid (12 chars of Crockford base32 minus i/l/o/u). */
const TENANT_REGISTRATION_GUARD = /^registrations\/[0-9a-hjkmnp-tv-z]{12}\/(dev|test|prod)\.yaml$/;

const guard = makeRegistrationGuard(TENANT_REGISTRATION_GUARD, "registrations/<guid>/<stage>.yaml");

/** The directory every stage file of ONE tenant stands in. */
const tenantDir = (guid: string): string => `registrations/${guid}`;

/** registrations/<guid>/<stage>.yaml — the path of ONE tenant registration. */
const registrationPath = (stage: Stage, guid: string): string => `${tenantDir(guid)}/${stage}.yaml`;

/** WHY a YAML parse failed, in one line. Shared by the strict fold and the tolerant scan so a broken
 *  file reads identically whether it THREW the read or was SKIPPED by it; schemaWhy (registration-laws.ts)
 *  is the same for a body that failed its schema. */
const yamlWhy = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type RegisteredApp = TenantRegistration["apps"][number];

/** An apps[] entry that is a website, the only kind that can hold `main`. */
const isWebsite = (a: RegisteredApp): boolean => Boolean(a.folder && a.site);

/** `apps` with `main` on `holder` alone, or on none where `holder` is null: the one place the mark is
 *  set, so no write can leave two holders or keep a stale one. */
const markMain = (apps: readonly RegisteredApp[], holder: string | null): RegisteredApp[] =>
  apps.map(({ main: _held, ...a }) => (a.name === holder ? { ...a, main: true as const } : a));

/** Where `main` goes when its holder leaves the tenant, `left` being the apps that stay: to `mainTo` where that website still stands
 *  (an aborted add gives it back to the website that held it before; null leaves the tenant without), else
 *  to the first website left in apps[] order, else to none. */
function heirOfMain(left: readonly RegisteredApp[], mainTo: string | null | undefined): string | null {
  if (mainTo === null) return null;
  if (mainTo !== undefined && left.some((a) => a.name === mainTo && isWebsite(a))) return mainTo;
  return left.find(isWebsite)?.name ?? null;
}

/** ONE tenant as the TOLERANT scan sees it: the registration fields a DISCOVERY (the orphan scan) or a
 *  REMOVAL (tenant-purge / the replace, via tenant-replace.ts) needs. `guid`/`stage` come from the PATH
 *  — the body carries neither, so the two can never disagree. */
export interface ScannedTenant {
  guid: string;
  subdomain: string;
  stage: Stage;
  cluster: string;
  apps: TenantRegistration["apps"];
  /** The standing members this tenant was created with, off its own registration — what a teardown
   *  deletes one AppProject per. Read from the file rather than assumed, so a scan of a tenant of any
   *  product names the members that tenant actually has. */
  members: string[];
  identityProvider: string;
  /** The tenant's own domain, or "" — the inventory lists its record beside the zone's. */
  ownDomain: string;
  /** The hosts that redirect to the own domain, and its alias domains — the inventory lists their records too. */
  ownDomainRedirects: string[];
  ownDomainAliases: string[];
  senderDomain: string;
  /** The apps bundle image this tenant builds from, or "" — a removal keeps the bundle's build
   *  registration while any other tenant records the same image. */
  appsImage: string;
}

/** The three HONEST outcomes of reading ONE tenant registration, kept apart because the callers act
 *  differently on each: "absent" is the only one that means "there is nothing here" (a resumed removal
 *  skips on it), while "unreadable" means a file DOES stand at that path — its body just cannot be
 *  trusted, so a removal must still git-rm it by path and a scan must still report it. */
export type TenantScan =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | { status: "read"; entry: ScannedTenant };

/** A build a stage pin file names now, with every tag the file has named for it, newest first. */
export interface PinHistory {
  name: string;
  image: string;
  tag: string;
  released: string[];
}

export interface TenantRead {
  entry: TenantRegistration;
}

/** The write set for ONE tenant registration — a single file, serialized through the shared
 *  serialize -> validate -> re-parse round-trip. Exported for the domain steps + tests. */
export function tenantRegistrationWrite(stage: Stage, guid: string, registration: TenantRegistration): { path: string; content: string } {
  return { path: guard(registrationPath(stage, guid)), content: serializePointer(TenantRegistrationSchema, registration) };
}

/** The builds a stage pin file names; an entry without a name or an image is none. */
function pinnedBuildsIn(raw: string): { name: string; image: string; tag: string }[] {
  const builds = (parseYaml(raw) as { builds?: { name?: unknown; image?: unknown; tag?: unknown }[] } | null)?.builds ?? [];
  return builds.flatMap((b) => (typeof b.name === "string" && typeof b.image === "string" ? [{ name: b.name, image: b.image, tag: typeof b.tag === "string" ? b.tag : "" }] : []));
}

/** The pin histories of `pinsDirs` inside an already-fetched books worktree (listPinHistories). */
async function pinHistoriesIn(books: BranchScope, stage: Stage, pinsDirs: readonly string[]): Promise<ReadonlyMap<string, PinHistory[]>> {
  const files = await Promise.all([...new Set(pinsDirs)].map(async (pinsDir) => {
    const path = `${pinsDir}/pins-${stage}.yaml`;
    return { pinsDir, now: await books.readFile(path), history: await books.readFileHistory(path) };
  }));
  return new Map(files.map(({ pinsDir, now, history }) => {
    if (now === null) return [pinsDir, []];
    const released = new Map<string, string[]>();
    for (const raw of history) {
      for (const b of pinnedBuildsIn(raw)) {
        const tags = released.get(b.name) ?? [];
        if (b.tag && !tags.includes(b.tag)) tags.push(b.tag);
        released.set(b.name, tags);
      }
    }
    return [pinsDir, pinnedBuildsIn(now).map((b) => ({ ...b, released: released.get(b.name) ?? [] }))];
  }));
}

/** One registration file's body, strict: THROWS on a body that is no YAML or fails the schema. */
function parseRegistration(path: string, raw: string): TenantRegistration {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw errInternal(`tenant registration ${path} is not valid YAML: ${yamlWhy(e)}`);
  }
  const r = TenantRegistrationSchema.safeParse(parsed);
  if (!r.success) throw errInternal(`tenant registration ${path} failed its schema: ${schemaWhy(r.error)}`);
  return r.data;
}

export class TenantRegistrations {
  readOnlyView(): TenantRegistrations { return new TenantRegistrations(readOnlyPlatformRepo(this.repo)); }

  async compareDomainFields(stage: Stage, guid: string, changes: readonly DomainChange[], reverse: boolean, runId: string): Promise<void> {
    if (changes.some(c => !["ownDomain", "ownDomainRedirects", "apps", "members"].includes(c.path[0]!))) throw errValidation("tenant domain migration contains a non-domain field");
    if (!changes.length) return;
    await this.repo.withBranch(this.branch, async books => {
      const path = guard(registrationPath(stage, guid)), raw = await books.readFile(path);
      if (raw === null) throw errValidation(`tenant ${guid}/${stage} disappeared`);
      const entry = parseRegistration(path, raw), next = applyDomainChanges(entry, changes, reverse);
      await books.commit({ message: `tenant-domain(${guid}): ${reverse ? "restore" : "move"} ${stage} ${trailer(runId)}`, write: [tenantRegistrationWrite(stage, guid, next)] });
    });
  }

  /** `repo` is the deploy repository, where the registrations live. */
  constructor(private readonly repo: PlatformRepo) {}

  /** The branch every read and every commit below stands on — this installation's books in
   *  the deploy repository, resolved once when the repo port was built, and the same name hostyour-cloud's
   *  books carry (one installation, one books branch, in both repositories). Exposed for the
   *  git-branch LOCK every tenant run claims — keyed on anything but the branch actually written, the
   *  lock serializes nothing — and as THE REVISION OF THE DEPLOY REPOSITORY THIS INSTALLATION READS: the member
   *  charts stand here too, because every source of a member Application names one revision of the
   *  deploy repository or ArgoCD's repo-server generates no manifest for it at all (hostyour-cloud
   *  clusters/argocd/files/tenants-appset.yaml). A gate that rendered the deploy repository's trunk instead
   *  would approve a chart the cluster never reads. */
  get branch(): string {
    return this.repo.booksBranch;
  }

  /** Read ONE tenant's registration for a stage, or null if not onboarded. The file is written by this
   *  registrations's flat "key: <json>" serializer, which is a SUBSET of YAML, so it is read with a real
   *  YAML parser — a hand-corrected file with comments or block-style lists still folds. */
  async readTenant(stage: Stage, guid: string): Promise<TenantRead | null> {
    const path = registrationPath(stage, guid);
    const raw = await this.repo.withBranch(this.branch, (books) => books.readFile(path));
    return raw === null ? null : { entry: parseRegistration(path, raw) };
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
    return {
      status: "read",
      entry: {
        guid, stage, subdomain: r.data.subdomain, cluster: r.data.cluster, apps: r.data.apps,
        members: r.data.members.map((m) => m.name), identityProvider: r.data.identityProvider, ownDomain: r.data.ownDomain,
        ownDomainRedirects: r.data.ownDomainRedirects, ownDomainAliases: r.data.ownDomainAliases ?? [],
        senderDomain: r.data.senderDomain ?? "", appsImage: r.data.appsImage ?? "",
      },
    };
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
   *  holds a candidate unit name against, because a consumer named after one would serve a label
   *  under the parent that tenant's IdP scopes its session cookies to (unit-dns.ts). Stage-free
   *  deliberately: the cookie Domain carries no stage, and two clusters may share one
   *  `global.unitApex`, so a stage-scoped answer would miss a collision the browser does not. */
  async listTenantSubdomains(): Promise<string[]> {
    const subdomains = new Set<string>();
    for (const stage of STAGE) {
      for (const t of (await this.scanTenantStage(stage)).found) subdomains.add(t.subdomain);
    }
    return [...subdomains];
  }

  /** Commit ONE tenant's registration for ONE stage (create-tenant). Overwrite-idempotent on resume. */
  async commitTenant(input: { stage: Stage; guid: string; registration: TenantRegistration; runId: string }): Promise<{ commit: string; changed: boolean }> {
    const { stage, guid, registration, runId } = input;
    return this.repo.withBranch(this.branch, (books) =>
      books.commit({
        message: `create-tenant(${guid}): ${stage} on ${registration.cluster} + ${registration.apps.length} app(s) ${trailer(runId)}`,
        write: [tenantRegistrationWrite(stage, guid, registration)],
      }),
    );
  }

  /** Read-modify-write the apps[] matrix: append or drop one app. Reserved names + duplicates are
   *  refused with a clear VALIDATION error (the guard the schema's superRefine provides at write time,
   *  raised here so the operator sees it before a commit is attempted). add-app / remove-app. The app's
   *  versions move with it in the same commit: an append fixes `approved` as its own, a drop removes
   *  them. Returns the tenant's versions as written, for the row.
   *
   *  The tenant's main website moves in the same commit: an append of a website marked main takes the
   *  mark from the website that held it, and a drop of the website that holds it hands it on (heirOfMain;
   *  `mainTo` names the heir where the caller knows one). */
  async updateTenantApps(stage: Stage, guid: string, input: { op: "append" | "drop"; app: string; website?: TenantWebsite; member?: TenantMemberRecord; approved?: Record<string, string>; seedReference?: boolean; seedDemo?: boolean; selections?: Record<string, boolean>; databases?: readonly string[]; mainTo?: string | null; runId: string }): Promise<{ commit: string; approvedTags: TenantRegistration["approvedTags"] }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const { op, app, website, member, approved = {}, seedReference = false, seedDemo = false, selections = {}, databases, mainTo, runId } = input;
    const has = current.entry.apps.some((a) => a.name === app);
    if (op === "append" && has) throw errValidation(`app "${app}" already exists in tenant "${guid}"`);
    if (op === "append" && website && current.entry.apps.some((a) => a.folder === website.folder && a.site === website.site)) {
      throw errValidation(`site "${website.site}" already runs in tenant "${guid}"`);
    }
    // Held against THIS tenant's own members, not against a constant: both are named
    // <guid>-<name>-<stage>, so the app would claim the member's namespace, AppProject and Application.
    if (op === "append" && current.entry.members.some((m) => m.name === app)) {
      throw errValidation(`app name "${app}" is also a member of tenant "${guid}" — both are named <guid>-${app}-${stage}, so the app would claim the member's namespace and Application`);
    }
    if (op === "drop" && !has) throw errValidation(`app "${app}" is not in tenant "${guid}"`);
    if (op === "append" && !member) throw errValidation(`add-app for "${app}" carries no member record — the ApplicationSet fans out over members[], so the app would be recorded as owned and never deployed`);
    // A later-added app carries its selections too into the registration's apps[] entry, and its
    // MEMBER into members[] — the two lists move together, which the schema then holds them to.
    const left = current.entry.apps.filter((a) => a.name !== app);
    const appended = [...current.entry.apps, { name: app, ...(website ? { folder: website.folder, site: website.site } : {}), seedReference, seedDemo, selections, ...(databases ? { databases: [...databases] } : {}) }];
    const holdsMain = current.entry.apps.some((a) => a.name === app && a.main);
    const apps = op === "append" ? (website?.main ? markMain(appended, app) : appended) : holdsMain ? markMain(left, heirOfMain(left, mainTo)) : left;
    const members = op === "append" ? [...current.entry.members, member!] : current.entry.members.filter((m) => m.name !== app);
    const kept = Object.fromEntries(Object.entries(current.entry.approvedTags).filter(([m]) => m !== app));
    const approvedTags = op === "append" && Object.keys(approved).length > 0 ? { ...kept, [app]: approved } : kept;
    const runKind = op === "append" ? "tenant-add-app" : "tenant-remove-app";
    const sign = op === "append" ? "+" : "-";
    const { commit } = await this.write(stage, guid, { ...current.entry, apps, members, approvedTags }, `${runKind}(${guid}): ${sign}${app} ${trailer(runId)}`);
    return { commit, approvedTags };
  }

  /** Mark one website as the tenant's main website and clear the mark everywhere else (null clears it
   *  everywhere), in one commit. Writing the marks that stand writes the same bytes, which the books
   *  branch takes as no commit. tenant-set-website-main. */
  async setWebsiteMain(stage: Stage, guid: string, app: string | null, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    if (app !== null && !current.entry.apps.some((a) => a.name === app && isWebsite(a))) throw errValidation(`app "${app}" of tenant "${guid}" is no website`);
    return this.write(stage, guid, { ...current.entry, apps: markMain(current.entry.apps, app) }, `main-website(${guid}): ${app ?? "none"} ${trailer(runId)}`);
  }

  /** Flip the tenant-wide suspended field — a FIELD flip, NOT a git-mv: the file stays at its one path,
   *  the Application keeps being generated, and the chart renders the off state (replicas 0, no
   *  Ingress). A prune-based suspend would be destructive: the member charts render ServiceClaims whose
   *  deprovision finalizer drops the user AND the databases on ANY claim deletion, an ArgoCD prune
   *  included. tenant-suspend / tenant-resume. */
  async setTenantSuspended(stage: Stage, guid: string, suspended: boolean, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
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
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const runKind = quiesced ? "quiesce" : "unquiesce";
    return this.write(stage, guid, { ...current.entry, quiesced }, `${runKind}(${guid}) ${trailer(runId)}`);
  }

  /** Write the tenant's size word and its `quota` — the six figures that bound EVERY member namespace
   *  of it, resolved by the caller from the size table as it stands NOW — in one commit. The figures
   *  are what a cluster reads; the word says which size they were resolved from.
   *
   *  Two fields of one file, like the flips above; writing the same word and figures commits nothing,
   *  so a re-apply whose numbers did not move leaves no history. tenant-set-size. */
  async setSize(stage: Stage, guid: string, size: UnitSize, quota: UnitQuota, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, size, quota }, `size(${guid}) ${trailer(runId)}`);
  }

  async setDemo(stage: Stage, guid: string, demo: boolean, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const { demo: _previous, ...entry } = current.entry;
    return this.write(stage, guid, { ...entry, ...(demo ? { demo: true as const } : {}) }, `demo(${guid}): ${demo} ${trailer(runId)}`);
  }

  /** Write the tenant's own domain ("" = none, the tenant is reached at its zone), the hosts that
   *  redirect to it and its alias domains, in one commit; writing what it already has commits nothing.
   *  tenant-set-own-domain moves the DNS records around this write. */
  async setOwnDomain(stage: Stage, guid: string, ownDomain: string, ownDomainRedirects: readonly string[], ownDomainAliases: readonly string[], runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const hosts = [ownDomain, ...ownDomainRedirects, ...ownDomainAliases].filter(Boolean).join(", ");
    const { ownDomainAliases: _held, ...entry } = current.entry;
    return this.write(stage, guid, { ...entry, ownDomain, ownDomainRedirects: [...ownDomainRedirects], ...(ownDomainAliases.length ? { ownDomainAliases: [...ownDomainAliases] } : {}) }, `own-domain(${guid}): ${hosts || "none"} ${trailer(runId)}`);
  }

  /** Move one website to another site and the tenant's bundle to a release that carries that site:
   *  the website's apps[] entry, its member entry resolved again with the site, and appsImageTag in ONE
   *  commit. The website's engine and renderer boot with the site only beside a bundle that holds its
   *  folder, and every member of the tenant mounts that bundle. tenant-set-website-site. */
  async setWebsiteSite(stage: Stage, guid: string, app: string, site: string, member: TenantMemberRecord, appsImageTag: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const entry = current.entry.apps.find((a) => a.name === app);
    if (!entry?.site) throw errValidation(`app "${app}" of tenant "${guid}" is no website — it names no site`);
    if (member.name !== app) throw errValidation(`the member entry is "${member.name}"'s, not website "${app}"'s`);
    const apps = current.entry.apps.map((a) => (a.name === app ? { ...a, site } : a));
    const members = current.entry.members.map((m) => (m.name === app ? member : m));
    return this.write(stage, guid, { ...current.entry, apps, members, appsImageTag }, `website-site(${guid}): ${app} ${site} on ${appsImageTag} ${trailer(runId)}`);
  }

  /** Write the tenant's member entries whole, as resolved again off the product's manifest. The member
   *  set stays; tenant-refresh-members refuses a plan that would change it. `listedApps` carries each
   *  app's database list as its catalog entry declares it now. Only that list is taken: every other
   *  field of an app, and an app the list does not name, stays as the registration holds it at this
   *  write, so a run that changed an app since the plan keeps what it wrote. `appsImageTag`, where
   *  given, moves the apps bundle in the same commit, because the bundle release declares the lists. */
  async setMembers(stage: Stage, guid: string, members: readonly TenantMemberRecord[], runId: string, listedApps: readonly Pick<TenantRegistration["apps"][number], "name" | "databases">[] = [], appsImageTag?: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const lists = new Map(listedApps.map((a) => [a.name, a.databases]));
    const apps = current.entry.apps.map((a) => {
      if (!lists.has(a.name)) return a;
      const { databases: _held, ...rest } = a;
      const listed = lists.get(a.name);
      return listed ? { ...rest, databases: [...listed] } : rest;
    });
    return this.write(stage, guid, { ...current.entry, members: [...members], apps, ...(appsImageTag ? { appsImageTag } : {}) }, `refresh-members(${guid}): ${members.map((m) => m.name).join(", ")} ${trailer(runId)}`);
  }

  /** Each app's database list, as `listsFor` answers it off the apps the registration holds, written
   *  into its apps[] entries and nothing else: the forward step for a tenant registered before the
   *  lists were carried (tenant-app-databases.ts). The read and the write are one turn on the books
   *  branch, so no other write lands between them to be overwritten. Null where the tenant has no
   *  registration at this stage, or every list already stands: nothing is committed. */
  async setAppDatabases(stage: Stage, guid: string, listsFor: (apps: TenantRegistration["apps"]) => Readonly<Record<string, readonly string[]>>, writtenBy: string): Promise<{ commit: string } | null> {
    const path = registrationPath(stage, guid);
    return this.repo.withBranch(this.branch, async (books) => {
      const raw = await books.readFile(path);
      if (raw === null) return null;
      const entry = parseRegistration(path, raw);
      const apps = withAppDatabases(entry.apps, listsFor(entry.apps));
      if (apps.every((a, i) => JSON.stringify(a.databases) === JSON.stringify(entry.apps[i]?.databases))) return null;
      return books.commit({ message: `app-databases(${guid}): ${apps.map((a) => `${a.name} [${(a.databases ?? []).join(", ")}]`).join(", ")} ${trailer(writtenBy)}`, write: [tenantRegistrationWrite(stage, guid, { ...entry, apps })] });
    });
  }

  /** The builds a chart's stage pin file names on the books branch (`<chart>/pins-<stage>.yaml`,
   *  written by the release pipeline): what an approval for that chart may name. None where no
   *  release of this installation has pinned the chart yet. */
  async listPinnedBuilds(stage: Stage, chart: string): Promise<{ name: string; image: string; tag: string }[]> {
    const raw = await this.repo.withBranch(this.branch, (books) => books.readFile(`${chart}/pins-${stage}.yaml`));
    return raw === null ? [] : pinnedBuildsIn(raw);
  }

  /** The builds each stage pin file names now (`<pinsDir>/pins-<stage>.yaml`, the directory of a chart
   *  or of an apps bundle), each with every tag the file has named for it on the books branch, newest
   *  first: what releases have made available at this stage, then and now. ONE turn for every
   *  directory, because a turn fetches and resets the books worktree, and so the pins and their
   *  history are read off the same commit. A directory without a pin file answers []. */
  async listPinHistories(stage: Stage, pinsDirs: readonly string[]): Promise<ReadonlyMap<string, PinHistory[]>> {
    return this.repo.withBranch(this.branch, (books) => pinHistoriesIn(books, stage, pinsDirs));
  }

  /** ONE tenant's registration for a stage and the pin histories (listPinHistories) of the directories
   *  `pinsDirsOf` names for it, in ONE turn: the turn's fetch costs more than every read inside it, and
   *  the pins are read off the same commit as the registration. Null where the tenant is not onboarded. */
  async readTenantWithPinHistories(
    stage: Stage,
    guid: string,
    pinsDirsOf: (entry: TenantRegistration) => readonly string[],
  ): Promise<(TenantRead & { pins: ReadonlyMap<string, PinHistory[]> }) | null> {
    const path = registrationPath(stage, guid);
    return this.repo.withBranch(this.branch, async (books) => {
      const raw = await books.readFile(path);
      if (raw === null) return null;
      const entry = parseRegistration(path, raw);
      return { entry, pins: await pinHistoriesIn(books, stage, pinsDirsOf(entry)) };
    });
  }

  /** Write the image tags approved for this tenant alone. One field of one file; writing what it
   *  already carries commits nothing. */
  async setApprovedTags(stage: Stage, guid: string, approvedTags: Record<string, Record<string, string>>, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, approvedTags }, `approved-tags(${guid}) ${trailer(runId)}`);
  }

  /** Write the domain the tenant's mail is sent as ("" for the platform's own). One field of one file;
   *  writing what it already carries commits nothing. tenant-set-sender-domain waits for the members. */
  async setSenderDomain(stage: Stage, guid: string, senderDomain: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, senderDomain }, `sender-domain(${guid}) ${senderDomain || "platform"} ${trailer(runId)}`);
  }

  /** Write the tenant's display name ("" for none). One field of one file; writing what it already
   *  carries commits nothing. tenant-set-display-name waits for the members. */
  async setDisplayName(stage: Stage, guid: string, displayName: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, displayName }, `display-name(${guid}) ${trailer(runId)}`);
  }

  /** Write the tenant's own apps bundle — the repository, the image it builds and the tag its last
   *  release built (shared/tenant.ts appsBundleFields), the three the fan-out mounts the tenant's
   *  bundle from. One field triple of one file, like the flips above; writing the same values
   *  commits nothing. tenant-apps-repo. */
  async setTenantAppsRepo(stage: Stage, guid: string, apps: { appsRepo: string; appsImage: string; appsImageTag: string }, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    return this.write(stage, guid, { ...current.entry, ...apps }, `tenant-apps-repo(${guid}): ${apps.appsImage} ${trailer(runId)}`);
  }

  /** Write a tenant's bundle tag and its engines' tags in ONE commit (tenant-line-move). A bundle and
   *  its engines on different lines are refused everywhere (engine-line.ts), so a move to a new line
   *  that wrote them one after the other would render a pairing in between that no member can run.
   *  The bundle's repository and image stay what they are; a tenant without a bundle has no line. */
  async setLinePairing(stage: Stage, guid: string, pairing: { appsImageTag: string; approvedTags: Record<string, Record<string, string>> }, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    if (!current.entry.appsImage) throw errValidation(`tenant "${guid}" runs no apps bundle, so it runs no engine line to move`);
    return this.write(stage, guid, { ...current.entry, ...pairing }, `line-move(${guid}): ${current.entry.appsImage} ${pairing.appsImageTag} ${trailer(runId)}`);
  }

  /** The inverse of setTenantAppsRepo (tenant-apps-repo-remove.ts): the tenant is its platform alone
   *  again, the three bundle fields gone together the way the schema demands them together. */
  async clearTenantAppsRepo(stage: Stage, guid: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
    const { appsRepo: _gone, ...rest } = current.entry;
    return this.write(stage, guid, { ...rest, appsImage: "", appsImageTag: "" }, `tenant-apps-repo(${guid}): removed ${trailer(runId)}`);
  }

  /** Repoint the tenant's `cluster` field — the whole bracket moves at once: every member appset
   *  selects on this one field, so the source slave stops generating the fan-out and the target
   *  starts. The file keeps its path, so a tenant moves within its stage, never across one. */
  async setTenantCluster(stage: Stage, guid: string, cluster: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readTenant(stage, guid);
    if (!current) throw errValidation(`tenant "${guid}" is not onboarded`);
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
      throw errValidation(`tenant "${guid}" is not onboarded`);
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
