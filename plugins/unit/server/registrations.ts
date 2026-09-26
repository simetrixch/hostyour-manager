// Registrations — the Manager's ONLY writer of the platform repo's
// registrations/**, and the ONE writer of EVERY file of a unit. Policy lives here; transport lives in
// the PlatformRepo git adapter; the laws every write obeys (path guard, serialize -> validate ->
// re-parse, run-id trailer) live in registration-laws.ts, shared with the tenant-shaped registrations
// (tenant-registrations.ts).
//
// THE STAGE IS THE PATH'S. `registrations/<unit>/<stage>.yaml` states the unit's stage, and the
// `cluster` field inside it names any active cluster: the cluster's own map carries the platform's
// stage, which decides nothing about a unit, so nothing here compares the two. What a stage is still
// held against is the channel ceiling, at the onboarding's plan.
//
// The tree: registrations/<unit>/build.yaml (stage-free, EVERY unit) plus registrations/<unit>/
// <stage>.yaml for a DEPLOYABLE unit. All of it on ONE branch — the appsets' files generator reads
// them all at once and selects on the `cluster` field, so they cannot be spread over the install
// branches they name. That branch is this installation's BOOKS (shared/branches.ts): the install
// branch of the cluster holding the master role, which is where the generators are stamped to read
// them. Never the trunk — a registration there would belong to every installation cut from it.
//
// ONE FILE OUTSIDE registrations/** is written here as well: installation/values/postfix-<stage>.yaml,
// the relay target the relay of a stage loads. It follows the stage's mail sender — the one unit whose
// SMTP entry is attested there (G29) — in the very commit that changes the sender's registration
// (relayTarget below), so the relay and the books never disagree about where the stage's mail goes.
import { ConsumerRegistrationSchema, publicFqdn, type ConsumerRegistration, type ConsumerStageRegistration, type SmtpEntry } from "#core/shared/consumer.ts";
import { clusterMapPath, type ClusterValueFile } from "#core/shared/cluster-values.ts";
import { readClusterValueChain } from "#core/server/domains/inventory/cluster-value-chain.ts";
import type { UnitQuota } from "../shared/unit-size.ts";
import { STAGE, type Stage } from "#core/shared/enums.ts";
// The scan's skipped-registration shape is a WIRE shape: the detected-consumer scan
// (consumer-detected.ts) hands these to the browser verbatim, so it is declared once in
// shared/api-types.ts and used here — the same rule tenant-registrations.ts follows for
// SkippedTenantPointerView.
import type { SkippedConsumerPointerView } from "#core/shared/api-types.ts";
import type { BranchScope, PlatformRepo } from "#core/server/adapters/git/port.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import { resolveClusterMarkingIn } from "#core/server/domains/inventory/cluster-marking.ts";
import { makeRegistrationGuard, migrateRegistrationFiles, parseRegistration, schemaWhy, serializePointer, trailer, type RegistrationMigration } from "./registration-laws.ts";

const REGISTRATION_GUARD = /^registrations\/[a-z0-9-]+\/(dev|test|prod|build)\.yaml$/;

/** registrations/<unit>/build.yaml — the stage-free build registration EVERY unit carries. */
const buildPath = (name: string): string => `registrations/${name}/build.yaml`;
/** registrations/<unit>/<stage>.yaml — a DEPLOYABLE unit's per-stage registration. */
const stagePath = (stage: Stage, name: string): string => `registrations/${name}/${stage}.yaml`;
/** installation/values/postfix-<stage>.yaml — the relay target of a stage, an optional values file of
 *  the relay (hostyour-cloud#242). */
const relayPath = (stage: Stage): string => `installation/values/postfix-${stage}.yaml`;

/** The relay target's bytes: the relay of [stage] hands its mail to [unit]'s SMTP entry at the
 *  tailnet address of the cluster the unit stands on — RELAYHOST for the relay itself, and the same
 *  target as `relayTarget` for the relay's own NetworkPolicy, which opens exactly that destination.
 *  Each value is JSON-encoded, serializePointer's rule: valid YAML, and it cannot smuggle a key. */
function relayValues(unit: string, stage: Stage, apiHost: string, port: number): string {
  return [
    `# Written by the Manager from the registration of ${unit} at ${stage}, the one unit whose SMTP entry is`,
    "# attested there: the relay of this stage hands its mail to that entry over the tailnet. Removed when",
    "# no unit of the stage declares one.",
    "postfix:",
    "  config:",
    "    general:",
    `      RELAYHOST: ${JSON.stringify(`[${apiHost}]:${port}`)}`,
    "relayTarget:",
    `  address: ${JSON.stringify(apiHost)}`,
    `  port: ${port}`,
  ].join("\n") + "\n";
}

const guard = makeRegistrationGuard(REGISTRATION_GUARD, "registrations/<unit>/(dev|test|prod|build).yaml");
const relayGuard = makeRegistrationGuard(/^installation\/values\/postfix-(dev|test|prod)\.yaml$/, "installation/values/postfix-(dev|test|prod).yaml");

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

/** What ONE unit's registration set says, as the writer is asked to commit it: the stage-free build
 *  half (always written) and, for a DEPLOYABLE unit, the deploy group of ONE stage. Splitting the input
 *  this way is what makes "a build.yaml never gets a deploy-group field" structural rather than a
 *  convention the caller has to remember. */
export interface RegistrationCommit {
  /** The fields both files share — the unit's identity and its two pause flags. */
  unit: Pick<ConsumerRegistration, "name" | "repoURL" | "owner" | "onboardedAt" | "suspended" | "quiesced">;
  /** The ATTESTED build names of the unit — build.yaml's own field. Empty ⇒ the unit builds nothing. */
  builds: string[];
  /** The deploy group of ONE stage, plus the OPTIONAL domain the unit answers at beside its platform
   *  host at that stage — which only a restore names, carrying the dumped registration's. Absent, the
   *  domain the standing stage file carries is kept: setFqdn below is its writer, and a second
   *  registration of a standing stage does not take it away. Absent deploy ⇒ a build-only unit:
   *  build.yaml is written, no stage file. */
  deploy?: { stage: Stage; chartPath: string; cluster: string; host: string; databases: string[]; keyPatterns: string[]; channelPatterns: string[]; services: ConsumerRegistration["services"]; size: ConsumerStageRegistration["size"]; mongodb: ConsumerStageRegistration["mongodb"]; quota: UnitQuota; fqdn?: string; smtpEntry?: SmtpEntry };
}

export class Registrations {
  /** `repo` is the platform GitOps repo (hostyour-cloud), which carries the registrations. */
  constructor(private readonly repo: PlatformRepo) {}

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
   *  this set: a consumer serves `<label>.<stage apex>`, a label under the very parent a tenant
   *  of that subdomain scopes its session cookies to (unit-dns.ts). The DIRECTORY is the answer here,
   *  not the files inside it — a unit half-way through an onboard or a teardown still owns the name. */
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
    const attested: { unit: string; build: string }[] = [];
    for (const { unit, entry } of await this.listBuildRegistrations()) {
      if (unit === exceptUnit) continue;
      for (const build of entry.builds ?? []) attested.push({ unit, build });
    }
    return attested;
  }

  /** Every BUILD registration the branch carries — `registrations/<unit>/build.yaml`, parsed — in
   *  directory order. A unit without one (deploy-only) is not listed. THROWS on a build.yaml that
   *  does not read or does not validate, naming the file: every reader of this set (the build-name
   *  uniqueness check, the App-token refresh) would otherwise run over a set that silently shrank. */
  async listBuildRegistrations(): Promise<{ unit: string; entry: ConsumerRegistration }[]> {
    return this.repo.withBranch(this.branch, async (books) => {
      const registrations: { unit: string; entry: ConsumerRegistration }[] = [];
      for (const unit of await books.listDir("registrations")) {
        const path = buildPath(unit);
        const raw = await books.readFile(path);
        if (raw === null) continue;
        try {
          registrations.push({ unit, entry: ConsumerRegistrationSchema.parse(parseRegistration(raw)) });
        } catch (e) {
          throw errValidation(`${path} is not a readable build registration, so the build-name uniqueness check cannot be trusted: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return registrations;
    });
  }

  /** Every domain a unit answers at on the registration branch — each `registrations/<unit>/<stage>.yaml`
   *  `fqdn` — EXCEPT the one at `except`. The set a domain about to be given to a unit is held against,
   *  and a restore's dumped domain: one domain carries one record, so it serves one unit at one stage,
   *  and the SAME unit's OTHER stages stay IN the set.
   *
   *  THROWS on a stage file that does not read or does not validate, naming the file — the
   *  listAttestedBuildNames rationale: skipping an unreadable file would silently shrink the set the
   *  uniqueness check runs against, and a name that is in fact taken would be given a second time. */
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
          throw errValidation(`${path} is not a readable stage registration, so the domain uniqueness check cannot be trusted: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (entry.fqdn !== undefined) attested.push({ unit, stage, fqdn: entry.fqdn });
      }
    }
    return attested;
    });
  }

  /** Every unit whose stage registration at [stage] carries an attested SMTP entry, with the cluster
   *  it stands on — the stage's mail sender. G29 holds a candidate that declares an entry against it
   *  (one sender per stage), and the Mail page detects the sender by it. THROWS on a stage file that
   *  does not read or validate, naming it, for the listAttestedFqdns reason: a skipped file would
   *  hide a sender and let a second one in. */
  async listSmtpSenders(stage: Stage): Promise<{ unit: string; cluster: string; entry: SmtpEntry }[]> {
    return this.repo.withBranch(this.branch, async (books) => {
      const senders: { unit: string; cluster: string; entry: SmtpEntry }[] = [];
      for (const unit of await books.listDir("registrations")) {
        const path = stagePath(stage, unit);
        const raw = await books.readFile(path);
        if (raw === null) continue;
        let entry: ConsumerRegistration;
        try {
          entry = ConsumerRegistrationSchema.parse(parseRegistration(raw));
        } catch (e) {
          throw errValidation(`${path} is not a readable stage registration, so the stage's mail sender cannot be read: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (entry.smtpEntry !== undefined && entry.cluster !== undefined) senders.push({ unit, cluster: entry.cluster, entry: entry.smtpEntry });
      }
      return senders;
    });
  }

  /** The host LABEL every OTHER unit stands on at [stage], off the stage registrations — G23's input
   *  for the one-zone-one-name-space clause. A registration without `host` (none is written without
   *  one any more) stands on its name. */
  async listAttestedHostLabels(stage: Stage, except: { unit: string }): Promise<{ unit: string; host: string }[]> {
    return this.repo.withBranch(this.branch, async (books) => {
      const attested: { unit: string; host: string }[] = [];
      for (const unit of await books.listDir("registrations")) {
        if (unit === except.unit) continue;
        const path = stagePath(stage, unit);
        const raw = await books.readFile(path);
        if (raw === null) continue; // the unit does not deploy at this stage
        let entry: ConsumerRegistration;
        try {
          entry = ConsumerRegistrationSchema.parse(parseRegistration(raw));
        } catch (e) {
          throw errValidation(`${path} is not a readable stage registration, so the host-label check cannot be trusted: ${e instanceof Error ? e.message : String(e)}`);
        }
        attested.push({ unit, host: entry.host ?? unit });
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
  async listConsumerRegistrations(cluster: string, stage: Stage): Promise<{ registrations: ScannedConsumer[]; skipped: SkippedConsumerPointerView[] }> {
    return this.repo.withBranch(this.branch, async (books) => {
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
        const { chartPath, cluster: on, databases, services, size, mongodb, quota, host } = r.data;
        if (chartPath === undefined || on === undefined || databases === undefined || services === undefined || size === undefined || mongodb === undefined || quota === undefined || host === undefined) {
          skipped.push({ name, stage, reason: `${path} carries no deploy group (chartPath/cluster/databases/services/size/mongodb/quota/host) — a stage registration must` });
          continue;
        }
        if (on !== cluster) continue; // registered at this stage, but on another cluster
        registrations.push({ name, entry: { ...r.data, chartPath, cluster: on, databases, services, size, mongodb, quota, host } });
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
   *  invariant is what makes the two files structurally unable to contradict each other. */
  async commitRegistration(input: RegistrationCommit & { runId: string }): Promise<{ commit: string }> {
    const { unit, builds, deploy, runId } = input;
    const write: { path: string; content: string }[] = [
      { path: guard(buildPath(unit.name)), content: serializePointer(ConsumerRegistrationSchema, { ...unit, removing: false, builds }) },
    ];
    if (!deploy) {
      const message = `register(${unit.name}): build ${builds.length ? builds.join(", ") : "none"} ${trailer(runId)}`;
      return this.repo.withBranch(this.branch, (books) => books.commit({ message, write }));
    }
    return this.repo.withBranch(this.branch, async (books) => {
      // The domain the standing stage file carries, read in the turn this commit runs in: its `fqdn`
      // key alone, because a file the schema refuses for another field is what this commit writes over.
      const standing = await books.readFile(stagePath(deploy.stage, unit.name));
      const fqdn = deploy.fqdn ?? (standing === null ? undefined : publicFqdn.safeParse(parseRegistration(standing).fqdn).data);
      write.push({
        path: guard(stagePath(deploy.stage, unit.name)),
        content: serializePointer(ConsumerRegistrationSchema, {
          ...unit,
          removing: false,
          chartPath: deploy.chartPath,
          cluster: deploy.cluster,
          host: deploy.host,
          databases: deploy.databases,
          keyPatterns: deploy.keyPatterns,
          channelPatterns: deploy.channelPatterns,
          services: deploy.services,
          size: deploy.size,
          mongodb: deploy.mongodb,
          quota: deploy.quota,
          ...(fqdn !== undefined ? { fqdn } : {}),
          ...(deploy.smtpEntry !== undefined ? { smtpEntry: deploy.smtpEntry } : {}),
        }),
      });
      const relay = await this.relayTarget(books, deploy.stage, unit.name, deploy);
      return books.commit({ message: `register(${unit.name}): ${deploy.stage} on ${deploy.cluster} ${trailer(runId)}`, write: [...write, ...relay.write], remove: relay.remove });
    });
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

  /** Mark the stage registration as being REMOVED — the first commit of offboard, purge and the
   *  onboard abort. The consumers ApplicationSet selects on it and prunes the generated Application
   *  while the AppProject and the admission policy, generated off the same file, still stand; the
   *  file itself is removed (removeRegistration) only once ArgoCD reports the Application gone
   *  (hostyour-cloud#213). One-way: nothing unmarks a registration — a removal that stops is resumed. */
  async setRemoving(stage: Stage, name: string, runId: string): Promise<{ commit: string }> {
    return this.flip(stage, name, { removing: true }, `removing(${name}): ${stage} ${trailer(runId)}`);
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

  /** Write the stage registration's `fqdn` — the domain the unit answers at beside its platform host
   *  ("" takes it off). A FIELD write like the flips above, and the domain's one writer once the stage
   *  stands. Writing the domain the file already carries commits nothing. */
  async setFqdn(stage: Stage, name: string, fqdn: string, runId: string): Promise<{ commit: string }> {
    return this.flip(stage, name, { fqdn: fqdn === "" ? undefined : fqdn }, `domain(${name}): ${stage} ${fqdn || "none"} ${trailer(runId)}`);
  }

  /** Repoint the stage registration's `cluster` field — the WHOLE move, as far as GitOps is
   *  concerned: the delivery appset selects on this field, so the source cluster stops generating
   *  the Application and the target starts. The source's name moves into `leaving`, which the two
   *  fence appsets ALSO select on: the source keeps the AppProject the Application's own deletion
   *  needs, until clearLeaving takes the name off (hostyour-cloud#214). The file keeps its path, so a
   *  unit moves within its stage, never across one. */
  async setCluster(stage: Stage, name: string, cluster: string, runId: string): Promise<{ commit: string }> {
    const current = await this.readRegistration(stage, name);
    if (!current) throw errValidation(`consumer "${name}" is not registered at ${stage}`);
    const leaving = current.entry.cluster;
    const next = { ...current.entry, cluster, ...(leaving !== undefined && leaving !== cluster ? { leaving } : {}) };
    return this.repo.withBranch(this.branch, async (books) => {
      const relay = await this.relayTarget(books, stage, name, next);
      return books.commit({
        message: `migrate(${name}): ${leaving} -> ${cluster} ${trailer(runId)}`,
        write: [{ path: guard(stagePath(stage, name)), content: serializePointer(ConsumerRegistrationSchema, next) }, ...relay.write],
        remove: relay.remove,
      });
    });
  }

  /** Take `leaving` off the stage registration — the last GitOps act of a move, once the source
   *  Application is gone: the source's fence appsets stop selecting the file and prune the
   *  AppProject, the admission policy and the argo-sync grant. A registration that carries none is
   *  left as it stands (a resume, or a move that never set it). */
  async clearLeaving(stage: Stage, name: string, runId: string): Promise<{ commit: string } | null> {
    const current = await this.readRegistration(stage, name);
    if (!current) throw errValidation(`consumer "${name}" is not registered at ${stage}`);
    if (current.entry.leaving === undefined) return null;
    return this.flip(stage, name, { leaving: undefined }, `migrate(${name}): left ${current.entry.leaving} ${trailer(runId)}`);
  }

  /** Remove a unit's registration for ONE stage (offboard), and — when that was its LAST stage file —
   *  its build.yaml too: a unit with neither is not "build-only", it has left the platform, and a
   *  build.yaml nobody deploys from would keep a pipeline alive for a consumer that is gone. Reports
   *  which of the two it removed so the run log says what actually left the tree. */
  async removeRegistration(stage: Stage, name: string, runId: string): Promise<{ commit: string; unitRemoved: boolean }> {
    return this.repo.withBranch(this.branch, async (books) => {
      const path = stagePath(stage, name);
      if ((await books.readFile(path)) === null) {
        throw errValidation(`consumer "${name}" is not registered at ${stage}`);
      }
      const remove = [guard(path)];
      // Any OTHER stage still standing keeps the unit — and with it its build.yaml. Read inside the
      // turn this commit runs in, so the decision and the commit see one tree.
      const unitRemoved = (await this.stagesIn(books, name)).every((standing) => standing === stage);
      if (unitRemoved) remove.push(guard(buildPath(name)));
      const relay = await this.relayTarget(books, stage, name, null);
      const { commit } = await books.commit({
        message: `offboard(${name}): ${stage}${unitRemoved ? " + build" : ""} ${trailer(runId)}`,
        remove: [...remove, ...relay.remove],
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

  /** Every file of every unit — build.yaml and each stage file — brought to the schema this release
   *  ships (migrateRegistrationFiles), in ONE turn and at most ONE commit ending in `marker`. The
   *  boot runs it once (registrations-migration.ts). A file the schema refuses is answered by path
   *  and reason, never rewritten. */
  async migrateToSchema(marker: string): Promise<RegistrationMigration> {
    return this.repo.withBranch(this.branch, async (books) => {
      const paths: string[] = [];
      for (const unit of await books.listDir("registrations")) {
        paths.push(buildPath(unit), ...STAGE.map((stage) => stagePath(stage, unit)));
      }
      return migrateRegistrationFiles(books, ConsumerRegistrationSchema, paths, guard, marker);
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

  /** THE RELAY TARGET OF [stage] once [name]'s stage file becomes [next] (null: the file goes) — what
   *  joins the registration's own commit. G29 keeps ONE unit per stage carrying an SMTP entry, so the
   *  unit's own file decides: carrying one, the relay of the stage hands its mail to that entry at the
   *  tailnet address (`global.apiHost`) of the map of the cluster the unit stands on; having carried
   *  one and no longer, the file goes and the relay delivers directly; neither, and the file is another
   *  unit's or nobody's. Read in the caller's turn, so both files commit from one tree.
   *
   *  Whether the standing file carried an entry is asked of its keys, not through the schema: that is
   *  the whole question, and a file the schema refuses is exactly what a re-onboard writes over. */
  private async relayTarget(
    books: BranchScope, stage: Stage, name: string, next: Pick<ConsumerRegistration, "cluster" | "smtpEntry"> | null,
  ): Promise<{ write: { path: string; content: string }[]; remove: string[] }> {
    const path = relayGuard(relayPath(stage));
    if (next?.smtpEntry !== undefined && next.cluster !== undefined) {
      const { fqdn, apiHost } = await resolveClusterMarkingIn(books, next.cluster);
      // G29 refuses such a sender at the onboarding; a move onto such a cluster is refused here.
      if (apiHost === undefined) {
        throw errValidation(`${name} carries the SMTP entry of ${stage}, and ${clusterMapPath(fqdn)} carries no global.apiHost — the tailnet address the relay reaches the entry on, written by deploy-slave for a slave and by tailnet-record-address for a master`);
      }
      return { write: [{ path, content: relayValues(name, stage, apiHost, next.smtpEntry.port) }], remove: [] };
    }
    const raw = await books.readFile(stagePath(stage, name));
    return { write: [], remove: raw !== null && parseRegistration(raw).smtpEntry !== undefined ? [path] : [] };
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
  private async flip(stage: Stage, name: string, patch: { suspended?: boolean; quiesced?: boolean; removing?: boolean; leaving?: string | undefined; quota?: UnitQuota; fqdn?: string | undefined }, message: string): Promise<{ commit: string }> {
    return this.repo.withBranch(this.branch, async (books) => {
      const raw = await books.readFile(stagePath(stage, name));
      if (raw === null) throw errValidation(`consumer "${name}" is not registered at ${stage}`);
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
