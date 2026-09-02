// Registrations — the Manager's ONLY writer of the platform repo's
// registrations/**, and the ONE writer of EVERY file of a unit. Policy lives here; transport lives in
// the PlatformRepo git adapter. The laws, factored into reusable primitives (serializePointer /
// parseRegistration / trailer / makeRegistrationGuard / assertClusterStage) so the tenant-shaped registrations
// (tenant-registrations.ts) obeys the same ones:
//   - PATH GUARD: every write path matches its registrations's namespace regex — a traversal or a stray
//     path is a programming error (INTERNAL), never a commit. makeRegistrationGuard(pattern) mints one
//     guard per namespace (registrations/<unit>/… here; registrations/<guid>/… in the tenant registrations).
//   - SERIALIZE -> VALIDATE -> RE-PARSE: the registration is schema-validated, serialized, and the
//     serialized bytes are re-parsed + re-validated before staging (anti-injection). Values are
//     JSON-encoded, which is valid YAML (JSON ⊂ YAML) and cannot smuggle extra keys; the YAML parse
//     restores nested objects/arrays. The round-trip verifier compares by DEEP equality (canonical
//     JSON), not reference — a nested value (builds[], apps[]) always re-parses to a NEW reference, so
//     a reference `!==` would falsely throw INTERNAL on every nested commit.
//   - RUN-ID TRAILER: every commit message ends with [<runId>] so a commit is always traceable to
//     an approved+succeeded Run.
//   - STAGE BOUNDARY: a registration for stage X may only name a cluster MARKED X. The marking lives in
//     ONE place (clusters/active/<fqdn>.yaml on the books branch, inventory/cluster-marking.ts) and the
//     check runs at the WRITER, so a mistake is refused before it is committed rather than discovered
//     when a prod workload appears on a dev cluster.
//
// The tree: registrations/<unit>/build.yaml (stage-free, EVERY unit) plus registrations/<unit>/
// <stage>.yaml for a DEPLOYABLE unit. All of it on ONE branch — the appsets' files generator reads
// them all at once and selects on the `cluster` field, so they cannot be spread over the install
// branches they name. That branch is this installation's BOOKS (shared/branches.ts): the install
// branch of the cluster holding the master role, which is where the generators are stamped to read
// them. Never the trunk — a registration there would belong to every installation cut from it.
import type { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ConsumerRegistrationSchema, type ConsumerRegistration, type ConsumerStageRegistration } from "../../../shared/consumer.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import { readClusterValueChain } from "../inventory/cluster-value-chain.ts";
import type { UnitQuota } from "../../../shared/unit-size.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
// The scan's skipped-registration shape is a WIRE shape: the detected-consumer scan
// (consumer-detected.ts) hands these to the browser verbatim, so it is declared once in
// shared/api-types.ts and used here — the same rule tenant-registrations.ts follows for
// SkippedTenantPointerView.
import type { SkippedConsumerPointerView } from "../../../shared/api-types.ts";
import type { BranchScope, PlatformRepo } from "../../adapters/git/port.ts";
import { AppError, errValidation } from "../../kernel/errors.ts";
import { clusterShortName, resolveClusterMarking } from "../inventory/cluster-marking.ts";

const REGISTRATION_GUARD = /^registrations\/[a-z0-9-]+\/(dev|test|prod|build)\.yaml$/;

/** registrations/<unit>/build.yaml — the stage-free build registration EVERY unit carries. */
const buildPath = (name: string): string => `registrations/${name}/build.yaml`;
/** registrations/<unit>/<stage>.yaml — a DEPLOYABLE unit's per-stage registration. */
const stagePath = (stage: Stage, name: string): string => `registrations/${name}/${stage}.yaml`;

/** Mint a path guard for one registration namespace: a write path MUST match `pattern` and contain no
 *  `..` traversal, else it is a programming error (INTERNAL), never a commit. Each registrations binds its
 *  own guard to its namespace regex (the consumer `guard` below; the tenant registrations supplies its own
 *  registrations/<guid>/ pattern) so both reuse the identical traversal-rejection. */
export function makeRegistrationGuard(pattern: RegExp, label: string): (path: string) => string {
  return (path: string): string => {
    if (!pattern.test(path) || path.includes("..")) {
      throw new AppError("INTERNAL", `path guard: "${path}" is outside ${label}`);
    }
    return path;
  };
}

const guard = makeRegistrationGuard(REGISTRATION_GUARD, "registrations/<unit>/(dev|test|prod|build).yaml");

/** Resolve the stage a cluster is MARKED for, named either by its short name or its FQDN. The two
 *  registration writers take this rather than a PlatformRepo, because the tenant registrations's own repo is
 *  catalog while the markings live on the platform repo. */
export type ClusterStageResolver = (cluster: string) => Promise<{ name: string; stage: Stage }>;

/** Bind a ClusterStageResolver to the platform repo — the ONE source of a cluster's stage
 *  (clusters/active/<fqdn>.yaml, written by install.sh). */
export function clusterStageFromMarkings(repo: PlatformRepo): ClusterStageResolver {
  return async (cluster: string) => {
    const marking = await resolveClusterMarking(repo, cluster);
    return { name: marking.name, stage: marking.stage };
  };
}

/** THE stage boundary: a registration for stage X may only name a cluster marked X. Refuses with
 *  both sides AND where each came from, so an operator reads the fix off the message instead of
 *  guessing which of the two is wrong. `subject` names the unit the registration is for. */
export async function assertClusterStage(resolve: ClusterStageResolver, cluster: string, stage: Stage, subject: string): Promise<void> {
  const marked = await resolve(cluster);
  if (marked.stage !== stage) {
    throw errValidation(
      `stage boundary: the registration for ${subject} names stage "${stage}" (the file registrations/…/${stage}.yaml) but cluster "${cluster}" is marked "${marked.stage}" in its cluster map clusters/active/*.yaml — stages never share a cluster, so either the registration targets the wrong cluster or the cluster's map is wrong`,
    );
  }
}

/** Canonical-JSON deep equality — the serialize round-trip's comparison. A reference `!==` holds
 *  only for flat scalars; a nested value (builds[], apps[]) always re-parses to a NEW reference, so it
 *  must be compared by value. JSON.parse preserves key insertion order, so a plain JSON.stringify
 *  compare is canonical for these re-parsed values. */
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Serialize a validated registration to flat YAML, then re-parse + re-validate the bytes. Each
 *  value is JSON-encoded — valid YAML, injection-safe. The round-trip is verified by DEEP equality so
 *  nested arrays round-trip cleanly instead of throwing on a reference mismatch. Generic over the
 *  schema so the consumer and tenant registries share one serializer. Throws INTERNAL if the round-trip
 *  diverges by value. */
export function serializePointer<T extends object>(schema: z.ZodType<T>, entry: T): string {
  const validated = schema.parse(entry);
  const yaml =
    Object.entries(validated)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") + "\n";
  const reparsed = schema.parse(parseRegistration(yaml)) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(validated)) {
    if (v !== undefined && !deepEqual(reparsed[k], v)) {
      throw new AppError("INTERNAL", `registration serialize round-trip diverged at "${k}"`);
    }
  }
  return yaml;
}

/** Parse a registration body back into an object. serializePointer WRITES flat "key: <json>", which
 *  is a SUBSET of YAML, so a body is READ with a real YAML parser — the same asymmetry
 *  tenant-registrations.ts readTenant states for the tenant half, and for its reason: a registration
 *  written by hand, with comments and block-style lists, still folds.
 *
 *  ONE registration is always written by hand. `registrations/hostyour-manager/build.yaml` is
 *  rendered from the deployment programs' `ansiwise/templates/platform-build-registration.tpl` by
 *  their `ansiwise/programs/deploy-branch.yaml:695-701` on a first installation, because the
 *  unit it registers is the one whose image this process runs — nothing is up yet that could write
 *  it. Under the flat reader that file failed on its first comment line, and listAttestedBuildNames
 *  throws where the stage scan skips, so gate G16 (validate.ts:234) refuses EVERY OTHER consumer's
 *  onboarding on a fresh installation, with a message about build-name uniqueness.
 *
 *  FOLDING IT IS NECESSARY AND NOT SUFFICIENT — THE REFUSAL IS STILL STANDING. The template writes
 *  `suspended: "false"` at platform-build-registration.tpl:31; this reader folds that file and
 *  ConsumerRegistrationSchema then refuses it on `suspended` with `Invalid input: expected boolean,
 *  received string`, which listAttestedBuildNames converts to the same errValidation as before. G16
 *  keeps refusing until that one template line reads `suspended: false`. The quotes buy nothing: the
 *  build fan-out selects on matchLabels `suspended: "false"` over a git FILES generator
 *  (hostyour-cloud apps/consumer-build/files/applicationset.yaml), and the boolean form
 *  serializePointer writes has matched that selector for every unit in every installation — flip()
 *  below records that same fact.
 *
 *  THE TENANT PATH IS ON THIS READ TOO. wire-units.ts:615 passes
 *  `() => registrations.listAttestedBuildNames()` with NO exceptUnit, so create-tenant.run.ts:628
 *  scans every unit including this one: on a fresh installation the FIRST TENANT fails here as well,
 *  not only the first other consumer.
 *
 *  TWO WRITERS STAND OVER THIS ONE FILE AND NOTHING ARBITRATES. commitRegistration and flip() emit it
 *  in serializePointer's flat `key: <json>` dialect, while deploy-branch.yaml:695-701 and
 *  regenerate-branch.yaml:517-522 render the template to the same path unconditionally and
 *  regenerate-branch.yaml:535-539 commits `registrations` — so the next installer run puts the
 *  commented form back over whatever this process wrote.
 *
 *  A document that is not a mapping is INTERNAL: a registration is an object, so a scalar or a list
 *  at the top level is a file that is not one. */
export function parseRegistration(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new AppError("INTERNAL", `registration is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new AppError("INTERNAL", `registration is not a YAML mapping: ${JSON.stringify(doc) ?? "empty"}`);
  }
  return doc as Record<string, unknown>;
}

/** The [<runId>] commit-message trailer — every registration commit ends with it. */
export const trailer = (runId: string): string => `[${runId}]`;

export interface RegistrationRead {
  entry: ConsumerRegistration;
}

/** ONE consumer as the TOLERANT stage scan sees it: the parsed stage registration, its deploy group
 *  narrowed to present. `name` is the DIRECTORY name — the path is the identity, and a body whose
 *  `name` disagrees with it never reaches this shape at all (listConsumerRegistrations refuses it into
 *  `skipped`). */
export interface ScannedConsumer {
  name: string;
  entry: ConsumerStageRegistration;
}

/** WHY a body failed its schema, as "path message; path message" — shared wording with the tenant
 *  registrations's schemaWhy so a broken registration reads identically across the two formats. */
const schemaWhy = (err: z.ZodError): string => err.issues.map((i) => i.path.join(".") + " " + i.message).join("; ");

/** What ONE unit's registration set says, as the writer is asked to commit it: the stage-free build
 *  half (always written) and, for a DEPLOYABLE unit, the deploy group of ONE stage. Splitting the input
 *  this way is what makes "a build.yaml never gets a deploy-group field" structural rather than a
 *  convention the caller has to remember. */
export interface RegistrationCommit {
  /** The fields both files share — the unit's identity and its two pause flags. */
  unit: Pick<ConsumerRegistration, "name" | "repoURL" | "repoCredentialId" | "owner" | "onboardedAt" | "suspended" | "quiesced">;
  /** The ATTESTED build names of the unit — build.yaml's own field. Empty ⇒ the unit builds nothing. */
  builds: string[];
  /** The deploy group of ONE stage, plus the OPTIONAL attested fqdn — the manifest's declared extra
   *  FQDN, copied here by the onboard run kind after G19 refused every name the platform already serves.
   *  Absent ⇒ a build-only unit: build.yaml is written, no stage file. */
  deploy?: { stage: Stage; chartPath: string; cluster: string; databases: string[]; services: ConsumerRegistration["services"]; size: ConsumerStageRegistration["size"]; mongodb: ConsumerStageRegistration["mongodb"]; quota: UnitQuota; fqdn?: string };
}

export class Registrations {
  /** `repo` is the platform GitOps repo (hostyour-cloud), which carries BOTH the registrations and the
   *  cluster markings; `clusterStage` reads the latter. */
  constructor(
    private readonly repo: PlatformRepo,
    private readonly clusterStage: ClusterStageResolver,
  ) {}

  /** The branch every read and every commit below stands on — this installation's books, resolved
   *  once when the repo port was built. Exposed because a run that commits through this registrations
   *  claims a git-branch LOCK, and a lock keyed on anything but the branch actually written
   *  serializes nothing: two runs would then push the same branch at the same time, each holding a
   *  key the other does not want. */
  get branch(): string {
    return this.repo.booksBranch;
  }

  /** Read a unit's registration for a stage, or null when it carries none there. */
  async readRegistration(stage: Stage, name: string): Promise<RegistrationRead | null> {
    const raw = await this.repo.withBranch(this.branch, (books) => books.readFile(stagePath(stage, name)));
    return raw === null ? null : { entry: ConsumerRegistrationSchema.parse(parseRegistration(raw)) };
  }

  /** Read a unit's BUILD registration — `registrations/<unit>/build.yaml`, the stage-free half — or
   *  null when it carries none (a deploy-only unit builds nothing). Its `suspended` is what the build
   *  ApplicationSet's post-selector filters on, and flip() below is its only writer after onboarding. */
  async readBuildRegistration(name: string): Promise<RegistrationRead | null> {
    const raw = await this.repo.withBranch(this.branch, (books) => books.readFile(buildPath(name)));
    return raw === null ? null : { entry: ConsumerRegistrationSchema.parse(parseRegistration(raw)) };
  }

  /** WHICH stages a unit stands at — every `registrations/<unit>/<stage>.yaml` the branch carries. The
   *  tree is what answers "does this unit survive": removeRegistration decides build.yaml's fate on it,
   *  and so does every UNIT-scoped teardown step, because a unit's stages share one build namespace,
   *  one repo PAT, one webhook and one release kit. */
  async readUnitStages(name: string): Promise<Stage[]> {
    return this.repo.withBranch(this.branch, (books) => this.stagesIn(books, name));
  }

  /** Every unit that holds a registration — one directory under `registrations/`, whatever stages or
   *  build.yaml it carries. The create-tenant subdomain belt holds a requested subdomain against
   *  this set: a consumer serves `<name>.<unitApex>`, which is the very host a tenant of that
   *  subdomain scopes its session cookies to (unit-dns.ts). The DIRECTORY is the answer here, not the
   *  files inside it — a unit half-way through an onboard or a teardown still owns the name. */
  async listUnitNames(): Promise<string[]> {
    return this.repo.withBranch(this.branch, (books) => books.listDir("registrations"));
  }

  /** Every build name ATTESTED by a unit OTHER than `exceptUnit` (every unit when none is named),
   *  read from every `registrations/<unit>/build.yaml` on the registration branch — the set gate G16
   *  holds a candidate unit's declared build names against, and the set a tenant's argo-sync subjects
   *  are derived from (build-rbac tenantSyncUnits). Since an image name is flat, a build name IS a
   *  registrations repository, and this tree is where every claim on one stands.
   *
   *  THROWS on a build.yaml that does not read or does not validate, naming the file. Unlike the
   *  tolerant stage scan there is no fail-soft here: skipping an unreadable file would silently shrink
   *  the set the uniqueness check runs against, and the gate would pass a name that is in fact taken. */
  async listAttestedBuildNames(exceptUnit?: string): Promise<{ unit: string; build: string }[]> {
    return this.repo.withBranch(this.branch, async (books) => {
    const attested: { unit: string; build: string }[] = [];
    for (const unit of await books.listDir("registrations")) {
      if (unit === exceptUnit) continue;
      const path = buildPath(unit);
      const raw = await books.readFile(path);
      if (raw === null) continue; // no build.yaml — the unit attests no build name
      let entry: ConsumerRegistration;
      try {
        entry = ConsumerRegistrationSchema.parse(parseRegistration(raw));
      } catch (e) {
        throw errValidation(`${path} is not a readable build registration, so the build-name uniqueness check cannot be trusted: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const build of entry.builds ?? []) attested.push({ unit, build });
    }
    return attested;
    });
  }

  /** Every extra FQDN ATTESTED on the registration branch EXCEPT the one at `except` (the candidate
   *  unit's own registration at the stage being onboarded — a re-onboard must not collide with
   *  itself), read from every `registrations/<unit>/<stage>.yaml` — the set gate G19 holds a
   *  candidate unit's declared fqdn against. The SAME unit's OTHER stages stay IN the set: the
   *  manifest's fqdn is stage-less while the attestation is per stage, so without them a multi-env
   *  unit would attest one FQDN at two stages and both clusters' policies would admit it.
   *
   *  THROWS on a stage file that does not read or does not validate, naming the file — the
   *  listAttestedBuildNames rationale: skipping an unreadable file would silently shrink the set the
   *  uniqueness check runs against, and the gate would grant a name that is in fact taken. */
  async listAttestedFqdns(except?: { unit: string; stage: Stage }): Promise<{ unit: string; stage: Stage; fqdn: string }[]> {
    return this.repo.withBranch(this.branch, async (books) => {
    const attested: { unit: string; stage: Stage; fqdn: string }[] = [];
    for (const unit of await books.listDir("registrations")) {
      for (const stage of STAGE) {
        if (except !== undefined && unit === except.unit && stage === except.stage) continue;
        const path = stagePath(stage, unit);
        const raw = await books.readFile(path);
        if (raw === null) continue; // the unit does not deploy at this stage
        let entry: ConsumerRegistration;
        try {
          entry = ConsumerRegistrationSchema.parse(parseRegistration(raw));
        } catch (e) {
          throw errValidation(`${path} is not a readable stage registration, so the fqdn uniqueness check cannot be trusted: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (entry.fqdn !== undefined) attested.push({ unit, stage, fqdn: entry.fqdn });
      }
    }
    return attested;
    });
  }

  /** Every consumer REGISTERED at this stage on this cluster, read from the GitOps registrations alone,
   *  AND every one the scan had to skip — the consumer twin of the tenant registrations's listTenantPointers,
   *  for the same reason: a consumer whose onboard died before record-inventory
   *  has a live registration and NO apps row, so scanning git is the only way to NAME it at all.
   *
   *  Selected by the registration's own `cluster` field against the short name derived from `domain` —
   *  the SAME selection the appset's post-selector makes, so what an operator sees here is what the
   *  cluster generates. FAIL-SOFT PER FILE: an unreadable/unparseable file, or one whose body name
   *  disagrees with its directory name, goes into `skipped` WITH the file it stands at and the reason —
   *  never dropped (a registration nobody hears about is a lie) and never a throw that wedges the whole
   *  scan on one drifted file. THROWS only when the branch itself cannot be read — the caller turns that
   *  into a visible "the scan failed", which must never flatten into an empty result. */
  async listConsumerRegistrations(domain: string, stage: Stage): Promise<{ registrations: ScannedConsumer[]; skipped: SkippedConsumerPointerView[] }> {
    return this.repo.withBranch(this.branch, async (books) => {
    const cluster = clusterShortName(domain);
    const registrations: ScannedConsumer[] = [];
    const skipped: SkippedConsumerPointerView[] = [];
    for (const name of await books.listDir("registrations")) {
      const path = `registrations/${name}/${stage}.yaml`;
      try {
        const raw = await books.readFile(path);
        if (raw === null) continue; // no file for this stage — the unit is build-only, or lives elsewhere
        const r = ConsumerRegistrationSchema.safeParse(parseRegistration(raw));
        if (!r.success) {
          skipped.push({ name, stage, reason: `${path} failed its schema: ${schemaWhy(r.error)}` });
          continue;
        }
        // The PATH is the identity (G1: directory name == consumer name == namespace). A body that
        // disagrees is refused, not re-keyed: adopting/purging by the BODY's name would aim at the
        // wrong namespace/AppProject and leave the actual leftover — at this file — untouched.
        if (r.data.name !== name) {
          skipped.push({ name, stage, reason: `${path} body name ("${r.data.name}") disagrees with its directory name ("${name}")` });
          continue;
        }
        // A file at <stage>.yaml MUST carry the deploy group. The schema alone cannot say so — both
        // forms share one object type and a deploy-group-less body parses as the BUILD form — so the
        // path's own claim is checked here, which is also what narrows the entry for every reader.
        const { chartPath, cluster: on, databases, services, size, mongodb, quota } = r.data;
        if (chartPath === undefined || on === undefined || databases === undefined || services === undefined || size === undefined || mongodb === undefined || quota === undefined) {
          skipped.push({ name, stage, reason: `${path} carries no deploy group (chartPath/cluster/databases/services/size/mongodb/quota) — a stage registration must` });
          continue;
        }
        if (on !== cluster) continue; // registered at this stage, but on another cluster
        registrations.push({ name, entry: { ...r.data, chartPath, cluster: on, databases, services, size, mongodb, quota } });
      } catch (e) {
        // parseRegistration throws AppError on invalid YAML and on a document that is not a mapping.
        skipped.push({ name, stage, reason: `${path} is not readable registration YAML: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return { registrations, skipped };
    });
  }

  /** Read the target cluster's values chain off its install branch, in layering order — the bytes
   *  every Application on that branch layers through the `$values` source, handed to the gate
   *  sandbox verbatim. The reading itself lives in domains/inventory/cluster-value-chain.ts, which
   *  the tenant family calls directly; two copies of it disagreed about whether a missing file is
   *  fatal. */
  async readClusterValueFiles(domain: string, stage: Stage): Promise<ClusterValueFile[]> {
    return readClusterValueChain(this.repo, domain, stage);
  }

  /** THE writer. Commits build.yaml ALWAYS — for a build-only AND for a deployable unit — plus the one
   *  stage file when a deploy group is given, in ONE commit. Nothing else in this process writes a file
   *  under registrations/<unit>/, which together with the schema's `name == basename(repoURL)`
   *  invariant is what makes the two files structurally unable to contradict each other.
   *
   *  The stage boundary is checked BEFORE anything is staged, so a registration aimed at a
   *  differently-marked cluster is refused rather than committed and reverted. */
  async commitRegistration(input: RegistrationCommit & { runId: string }): Promise<{ commit: string }> {
    const { unit, builds, deploy, runId } = input;
    const write: { path: string; content: string }[] = [
      { path: guard(buildPath(unit.name)), content: serializePointer(ConsumerRegistrationSchema, { ...unit, builds }) },
    ];
    let message = `register(${unit.name}): build ${builds.length ? builds.join(", ") : "none"} ${trailer(runId)}`;
    if (deploy) {
      await assertClusterStage(this.clusterStage, deploy.cluster, deploy.stage, `consumer ${unit.name}`);
      write.push({
        path: guard(stagePath(deploy.stage, unit.name)),
        content: serializePointer(ConsumerRegistrationSchema, {
          ...unit,
          chartPath: deploy.chartPath,
          cluster: deploy.cluster,
          databases: deploy.databases,
          services: deploy.services,
          size: deploy.size,
          mongodb: deploy.mongodb,
          quota: deploy.quota,
          ...(deploy.fqdn !== undefined ? { fqdn: deploy.fqdn } : {}),
        }),
      });
      message = `register(${unit.name}): ${deploy.stage} on ${deploy.cluster} ${trailer(runId)}`;
    }
    return this.repo.withBranch(this.branch, (books) => books.commit({ message, write }));
  }

  /** Flip the stage registration's `suspended` field — a FIELD flip, not a move between directories:
   *  the file stays at its one path, the Application keeps being generated, and the chart renders the
   *  off state (replicas 0, no Ingress). A prune-based suspend would be destructive by construction:
   *  the charts render ServiceClaims whose deprovision finalizer runs on EVERY claim deletion — an
   *  ArgoCD prune included — and drops the user AND the databases. suspend / resume. */
  async setSuspended(stage: Stage, name: string, suspended: boolean, runId: string): Promise<{ commit: string }> {
    return this.flip(stage, name, { suspended }, `${suspended ? "consumer-suspend" : "consumer-resume"}(${name}) ${trailer(runId)}`);
  }

  /** Flip the stage registration's `quiesced` field — the deeper pause, held while a removal is in
   *  flight. Separate from `suspended` so an operator-driven pause and a machine-driven one cannot
   *  overwrite each other's intent. */
  async setQuiesced(stage: Stage, name: string, quiesced: boolean, runId: string): Promise<{ commit: string }> {
    return this.flip(stage, name, { quiesced }, `${quiesced ? "quiesce" : "unquiesce"}(${name}) ${trailer(runId)}`);
  }

  /** Write the stage registration's `quota` — the six figures that bound the consumer's namespace,
   *  resolved by the caller from the size table as it stands NOW. A FIELD write like the flips above,
   *  not a re-registration: nothing else about the unit changes, and the appset's quota source picks
   *  the new numbers up on its next sync.
   *
   *  Idempotent by construction, and deliberately not short-circuited: writing the same figures
   *  commits nothing (the platform repo's empty-diff no-op), so a re-apply of a size whose numbers did
   *  not move costs a run and no history, while a re-apply after a table edit lands as one commit
   *  naming the unit. */
  async setQuota(stage: Stage, name: string, quota: UnitQuota, runId: string): Promise<{ commit: string }> {
    return this.flip(stage, name, { quota }, `size(${name}) ${trailer(runId)}`);
  }

  /** Repoint the stage registration's `cluster` field — the WHOLE move, as far as GitOps is
   *  concerned: the appsets select on this field, so the source cluster stops generating the
   *  Application and the target starts. The stage boundary holds here exactly as at registration:
   *  a unit moves within its stage, never across one. */
  async setCluster(stage: Stage, name: string, cluster: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readRegistration(stage, name);
    if (!current) throw new AppError("VALIDATION", `consumer "${name}" is not registered at ${stage}`);
    await assertClusterStage(this.clusterStage, cluster, stage, `consumer ${name}`);
    return this.repo.withBranch(this.branch, (books) =>
      books.commit({
        message: `migrate(${name}): ${current.entry.cluster} -> ${cluster} ${trailer(runId)}`,
        write: [{ path: guard(stagePath(stage, name)), content: serializePointer(ConsumerRegistrationSchema, { ...current.entry, cluster }) }],
      }),
    );
  }

  /** Remove a unit's registration for ONE stage (offboard), and — when that was its LAST stage file —
   *  its build.yaml too: a unit with neither is not "build-only", it has left the platform, and a
   *  build.yaml nobody deploys from would keep a pipeline alive for a consumer that is gone. Reports
   *  which of the two it removed so the run log says what actually left the tree. */
  async removeRegistration(stage: Stage, name: string, runId: string): Promise<{ commit: string; unitRemoved: boolean }> {
    return this.repo.withBranch(this.branch, async (books) => {
      const path = stagePath(stage, name);
      if ((await books.readFile(path)) === null) {
        throw new AppError("VALIDATION", `consumer "${name}" is not registered at ${stage}`);
      }
      const remove = [guard(path)];
      // Any OTHER stage still standing keeps the unit — and with it its build.yaml. Read inside the
      // turn this commit runs in, so the decision and the commit see one tree.
      const unitRemoved = (await this.stagesIn(books, name)).every((standing) => standing === stage);
      if (unitRemoved) remove.push(guard(buildPath(name)));
      const { commit } = await books.commit({
        message: `offboard(${name}): ${stage}${unitRemoved ? " + build" : ""} ${trailer(runId)}`,
        remove,
      });
      return { commit, unitRemoved };
    });
  }

  /** The build-only onboard's abort inverse: remove registrations/<name>/build.yaml — but ONLY when
   *  no stage file stands. A unit that is ALSO registered at a stage keeps its build attestation:
   *  the stage files' release pipelines render from it, and taking it back would fail every one of
   *  their runs at the attestation check. Reports whether anything actually left the tree. */
  async removeBuildRegistration(name: string, runId: string): Promise<{ removed: boolean }> {
    return this.repo.withBranch(this.branch, async (books) => {
      if ((await this.stagesIn(books, name)).length > 0) return { removed: false };
      if ((await books.readFile(buildPath(name))) === null) return { removed: false };
      await books.commit({
        message: `offboard(${name}): build ${trailer(runId)}`,
        remove: [guard(buildPath(name))],
      });
      return { removed: true };
    });
  }

  /** A unit's stage files inside an ALREADY-fetched worktree — the one tree read behind readUnitStages,
   *  removeRegistration and removeBuildRegistration, so a caller that is mid-commit does not fetch the
   *  branch a second time and cannot decide against a tree other than the one it commits to. */
  private async stagesIn(books: BranchScope, name: string): Promise<Stage[]> {
    const standing: Stage[] = [];
    for (const stage of STAGE) {
      if ((await books.readFile(stagePath(stage, name))) !== null) standing.push(stage);
    }
    return standing;
  }

  /** The read-modify-write behind setSuspended/setQuiesced: re-emit the WHOLE registration with one
   *  field changed. Partial rewrites are what silently drop fields, so there is no partial writer.
   *
   *  It ALSO carries build.yaml's own `suspended` — the field the build ApplicationSet's post-selector
   *  reads — because that file is the unit's, not the stage's, while suspend is per stage. The rule
   *  the two can both be true under: a unit stops building only once EVERY stage it stands at is
   *  suspended, and starts again the moment one resumes. Anything stricter would stop prod's releases
   *  because someone paused dev; anything looser is what this repo had, where build.yaml said
   *  `suspended: false` for every unit in every installation and the selector filtered nothing.
   *
   *  Both files move in ONE commit, from ONE read of the tree. Two commits would leave a window where
   *  the stage says paused and the build still runs, and a second fetch could decide against a tree
   *  other than the one it writes to. */
  private async flip(stage: Stage, name: string, patch: { suspended?: boolean; quiesced?: boolean; quota?: UnitQuota }, message: string): Promise<{ commit: string }> {
    return this.repo.withBranch(this.branch, async (books) => {
      const raw = await books.readFile(stagePath(stage, name));
      if (raw === null) throw new AppError("VALIDATION", `consumer "${name}" is not registered at ${stage}`);
      const entry = ConsumerRegistrationSchema.parse(parseRegistration(raw));
      const next = { ...entry, ...patch };
      const write = [{ path: guard(stagePath(stage, name)), content: serializePointer(ConsumerRegistrationSchema, next) }];

      // Only a `suspended` flip can change the unit-wide answer; a quiesce and a size leave it alone.
      if (patch.suspended !== undefined) {
        const buildRaw = await books.readFile(buildPath(name));
        if (buildRaw !== null) {
          const build = ConsumerRegistrationSchema.parse(parseRegistration(buildRaw));
          const others = (await this.stagesIn(books, name)).filter((s) => s !== stage);
          let anyRunning = patch.suspended === false;
          for (const s of others) {
            if (anyRunning) break;
            const other = await books.readFile(stagePath(s, name));
            if (other !== null && ConsumerRegistrationSchema.parse(parseRegistration(other)).suspended === false) anyRunning = true;
          }
          const buildSuspended = !anyRunning;
          if (build.suspended !== buildSuspended) {
            write.push({ path: guard(buildPath(name)), content: serializePointer(ConsumerRegistrationSchema, { ...build, suspended: buildSuspended }) });
          }
        }
      }
      return books.commit({ message, write });
    });
  }
}
