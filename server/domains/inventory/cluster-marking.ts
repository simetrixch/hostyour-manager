// cluster-marking.ts — THE resolution of a cluster to what the platform knows about it: its role,
// its stage, its short name and whether it carries the build plane. All four come from ONE file,
// `clusters/active/<fqdn>.yaml`, written by install.sh when the cluster is installed. Nothing else
// states any of them: a second writer is what let maps drift away from the branches they describe.
//
// EVERY cluster's map stands on ONE branch — this installation's books (shared/branches.ts), which is
// the install branch of the cluster holding the master role, and which the platform repo port carries
// as `booksBranch`. Not each cluster's own install branch: the slaves ApplicationSet is a git
// generator with one revision, and this module folds every map at once to catch short-name
// collisions, so both readers need them side by side. Not the trunk either — a map names a real
// FQDN, a stage and a business domain, and the trunk is what every future installation is cut from.
//
// The map's shape, and what each field drives:
//   fqdn         the cluster's public FQDN == its install branch == clusters.domain.
//   stage        dev | test | prod. A cluster carries exactly one, and a registration for stage X
//                may only point at a cluster marked X.
//   role         master | slave | master+slave — cluster MANAGEMENT only: who operates ArgoCD,
//                Vault, identity and the build plane for whom. Never a placement rule.
//   build-plane  the FQDN of the cluster that builds this one's images. The predicate is
//                `buildPlane := (build-plane == fqdn)`, so one field answers both "do I run the
//                build plane?" and "whose registry do I pull from?" — a cluster that builds
//                elsewhere names that other cluster here.
//   release      the platform release tag this cluster stands on, in the one release grammar
//                (shared/release.ts). THE pin: the install branch is regenerated from exactly this
//                tag, so the field and the branch state are one statement, and "this cluster runs
//                platform X" is a question with an answer. Absent on a cluster that has never had a
//                release run against it — the map is written at install time, the pin at release
//                time, and the two are separate events.
//   master       the managing master's FQDN. Present exactly for a cluster carrying the slave part.
//   apiHost      the address the master's IN-CLUSTER components dial the slave's kube-apiserver
//   apiPort      on, and its port. Present only on a pure slave. It is the slave's tailnet address
//                once the two share that private network, its LAN address when the slave sits in
//                the master's own network — the field says which apiserver endpoint git publishes,
//                never which network carries it. Four components read the address this field feeds:
//                the master's per-slave ArgoCD instance, Vault on every ESO login, the shared
//                dashboard's kubeconfig, and this process's per-slave kube client, which writes.
//   unit-apex    the public apex units (consumers and tenants) serve under, <name>.<unit-apex>.
//   platform-domain  the installation's business domain — the mail sender identity and the relay's
//                sender allowlist. install.sh writes it (defaulting to the unit apex) and
//                set-role.sh refuses a map without it.
//   post-url     where units reach the shared example-post service; absent on an installation
//                that has none.
//   catalog-repo the <owner>/<name> of the repository holding this installation's tenant charts
//                and their per-stage pins. install.sh demands it (nothing composes a repository
//                this cloud does not own) and set-role.sh refuses a map without it.
//
// This module PARSES the map and REGENERATES it key by key, so every key the file may carry has to
// be declared below even where nothing here decides anything with it: a key the schema does not
// know is a key the next write deletes. unit-apex is the worked example — set-role.sh refuses to
// stamp a cluster whose map has none.
//
// The cluster SHORT NAME is NOT a field. It is derived from `fqdn` as its first label, by
// clusterShortName below — the one derivation in this repo. A stored name would be a second writer
// of the same datum, and the ApplicationSet selector that derives it from the fqdn would then match
// nothing the moment the two disagreed.
//
// Boundary: domain layer — the db schema, shared/ and the git PlatformRepo port only. Deliberately
// imports NO other domain (inventory is the base domain every other one may read, not the reverse).
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { AppError, errValidation } from "../../kernel/errors.ts";
import { SERVER_ROLE, STAGE, type ServerRole, type Stage } from "../../../shared/enums.ts";
import { RELEASE_TAG_RE } from "../../../shared/release.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The directory the maps live in. */
export const CLUSTER_MARKING_DIR = "clusters/active";

/** The ONE derivation of a cluster's short name — the first label of its FQDN.
 *  `m1.example.com` -> `m1`. Every reader of a short name in this repo goes through here;
 *  the shell layer's `cluster_name_from_fqdn` and the ApplicationSet generators derive it the same
 *  way, so the three artifact families can never disagree about what a cluster is called. */
export function clusterShortName(fqdn: string): string {
  return fqdn.split(".")[0] || fqdn;
}

/** clusters/active/<fqdn>.yaml — the path of ONE cluster's map. */
export function clusterMarkingPath(fqdn: string): string {
  return `${CLUSTER_MARKING_DIR}/${fqdn}.yaml`;
}

/** The map as it stands on disk. Real YAML (the file carries comments), so it is parsed with the
 *  YAML reader rather than the flat "key: <json>" pointer reader. `build-plane` is REQUIRED: the
 *  registry host and the build-plane toggles are derived from it with no case distinction, so a map
 *  without it cannot be rendered at all — failing loud here names the file to fix.
 *
 *  STRICT, and that is the load-bearing part. Zod's default is to STRIP a key it does not declare;
 *  serializeMarking then regenerates the whole file from what survived, so an undeclared key is
 *  silently deleted from git by the next release run — a write nobody asked for, on a file install.sh
 *  documents as hand-editable. Strict turns that into an error naming the file and the key, which is
 *  also the whole migration path for a renamed field: a map still carrying the retired `lanHost` is
 *  refused out loud instead of quietly losing the only git-side record of where the master dials the
 *  slave. One unreadable map fails every read, because indexMarkings folds them all — the same blast
 *  radius the slaves ApplicationSet has under missingkey=error, and for the same reason. */
const ClusterMarkingFileSchema = z.object({
  fqdn: z.string().min(1),
  stage: z.enum(STAGE),
  role: z.enum(SERVER_ROLE),
  "build-plane": z.string().min(1),
  // Checked against the release grammar rather than accepted as free text: the field IS the pin, and
  // a value the grammar does not recognise names no state anything can be regenerated from.
  release: z.string().regex(RELEASE_TAG_RE, "must be a release tag <x.y.z>-<channel>-<ts14>").optional(),
  master: z.string().min(1).optional(),
  apiHost: z.string().min(1).optional(),
  apiPort: z.number().int().positive().optional(),
  // Nothing in this process decides anything with these four. They are declared and carried so a
  // write does not drop them; optional rather than required because the maps that predate them are
  // still valid markings. `alert-recipients` is the comma-separated mailbox list set-role.sh renders
  // into cluster/profile.yaml as global.alertRecipients — the trunk carries an empty list, because a
  // mailbox names one installation.
  "unit-apex": z.string().min(1).optional(),
  "platform-domain": z.string().min(1).optional(),
  "alert-recipients": z.string().min(1).optional(),
  "post-url": z.string().min(1).optional(),
  "catalog-repo": z.string().min(1).optional(),
}).strict();

/** Every key the strict schema accepts — its whole surface. install.sh is the map's writer, so the
 *  test suite compares this list against the keys install.sh's map-writing block emits: a field the
 *  installer gains fails ONE test naming the key, instead of failing every map read on the next
 *  fresh installation. */
export const CLUSTER_MARKING_FILE_KEYS = Object.keys(ClusterMarkingFileSchema.shape);

/** One cluster's marking, with the derived facts folded in. */
export interface ClusterMarking {
  /** The comment block the file opens with, VERBATIM, so a rewrite gives it back. install.sh
   *  write_map writes ~25 lines above the fields — what the file is, which branches carry it, why
   *  the short name is never stored, that the release pin has a different writer — and it documents
   *  the file as hand-editable. Without carrying this, the first release pin would delete the only
   *  thing that says how to edit it. NOT identity: sameMarking ignores it. */
  header?: string;
  fqdn: string;
  /** clusterShortName(fqdn) — derived, never read from the file. */
  name: string;
  role: ServerRole;
  stage: Stage;
  /** Does this cluster RUN the build plane? True exactly when `build-plane` names itself. */
  buildPlane: boolean;
  /** The FQDN of the cluster that builds this one's images (own fqdn when buildPlane). */
  buildPlaneFqdn: string;
  /** The platform release tag the cluster stands on. Absent until a release run has pinned one. */
  release?: string;
  master?: string;
  apiHost?: string;
  apiPort?: number;
  /** Carried, never read here — see the schema note on why an undeclared key is a deleted key. */
  unitApex?: string;
  /** Carried, never read here. */
  platformDomain?: string;
  /** Carried, never read here. */
  alertRecipients?: string;
  /** Carried, never read here. */
  postUrl?: string;
  /** Carried, never read here. */
  catalogRepo?: string;
}

/** The leading comment block of a map file: every line from the top until the first that is not a
 *  comment and not blank. Read off the TEXT, because a YAML parse drops comments entirely. */
function headerOf(text: string): string | undefined {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith("#") || lines[i]!.trim() === "")) i++;
  const header = lines.slice(0, i).join("\n").replace(/\s+$/, "");
  return header === "" ? undefined : header;
}

function foldMarking(path: string, raw: unknown, text?: string): ClusterMarking {
  const parsed = ClusterMarkingFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw errValidation(
      `cluster map ${path} is not a valid marking: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const m = parsed.data;
  const header = text === undefined ? undefined : headerOf(text);
  return {
    ...(header !== undefined ? { header } : {}),
    fqdn: m.fqdn,
    name: clusterShortName(m.fqdn),
    role: m.role,
    stage: m.stage,
    buildPlane: m["build-plane"] === m.fqdn,
    buildPlaneFqdn: m["build-plane"],
    ...(m.release !== undefined ? { release: m.release } : {}),
    ...(m.master !== undefined ? { master: m.master } : {}),
    ...(m.apiHost !== undefined ? { apiHost: m.apiHost } : {}),
    ...(m.apiPort !== undefined ? { apiPort: m.apiPort } : {}),
    ...(m["unit-apex"] !== undefined ? { unitApex: m["unit-apex"] } : {}),
    ...(m["platform-domain"] !== undefined ? { platformDomain: m["platform-domain"] } : {}),
    ...(m["alert-recipients"] !== undefined ? { alertRecipients: m["alert-recipients"] } : {}),
    ...(m["post-url"] !== undefined ? { postUrl: m["post-url"] } : {}),
    ...(m["catalog-repo"] !== undefined ? { catalogRepo: m["catalog-repo"] } : {}),
  };
}

/** Read every map under clusters/active and index it BOTH ways — by FQDN and by the derived short
 *  name — so a caller may name a cluster either way.
 *
 *  Two clusters whose FQDNs share a first label (`s1.dev.example` and `s1.example`) derive
 *  the SAME short name. Silently keeping the last one read would hand a caller the wrong cluster's
 *  role and stage, so the collision is a typed error naming both files. */
async function indexMarkings(repo: PlatformRepo): Promise<{ byFqdn: Map<string, ClusterMarking>; byName: Map<string, ClusterMarking> }> {
  return repo.withBranch(repo.booksBranch, async (books) => {
  const byFqdn = new Map<string, ClusterMarking>();
  const byName = new Map<string, ClusterMarking>();
  for (const entry of await books.listDir(CLUSTER_MARKING_DIR)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = `${CLUSTER_MARKING_DIR}/${entry}`;
    const text = await books.readFile(path);
    if (text === null) continue; // a directory entry, or removed between listing and reading
    const marking = foldMarking(path, parseYaml(text), text);
    const clash = byName.get(marking.name);
    if (clash) {
      throw errValidation(
        `cluster maps ${clusterMarkingPath(clash.fqdn)} and ${path} both derive the short name "${marking.name}" — a cluster is addressed by that name (ArgoCD instance, AppProject, Vault mount), so the two would collide; rename one cluster's first FQDN label`,
      );
    }
    byFqdn.set(marking.fqdn, marking);
    byName.set(marking.name, marking);
  }
  return { byFqdn, byName };
  });
}

/** Resolve ONE cluster's marking, named either by its FQDN (`s1.example.com`) or by its
 *  short name (`s1`) — the two spellings of the same identity, joined by clusterShortName.
 *  A cluster with no map is a typed error, not a default: role/stage/build plane have no safe
 *  fallback, and install.sh writes the map before the cluster is ever reachable. */
export async function resolveClusterMarking(repo: PlatformRepo, cluster: string): Promise<ClusterMarking> {
  const { byFqdn, byName } = await indexMarkings(repo);
  const found = byFqdn.get(cluster) ?? byName.get(cluster);
  if (!found) {
    throw errValidation(
      `no cluster map for "${cluster}" — expected ${clusterMarkingPath(cluster)} on ${repo.booksBranch}; every cluster is marked by install.sh at install time, so a missing map means the install never completed or the map was removed by hand`,
    );
  }
  return found;
}

/** WHERE a cluster's images are built, as its own map states it: the FQDN standing in `build-plane`.
 *  A caller that needs an address ON the build plane — the image-builder EventListener's ingress is the
 *  one there is — asks this rather than reusing the cluster it happens to be acting on, because the
 *  build plane is deployed on exactly one cluster and every other cluster's map names it. */
export type BuildPlaneFqdnResolver = (cluster: string) => Promise<string>;

/** Bind a BuildPlaneFqdnResolver to the platform repo, which carries the maps. Handed to the onboarding
 *  steps as a bound function rather than a PlatformRepo — the same shape the stage boundary
 *  (ClusterStageResolver) and the tenant unit apex arrive in, so a step keeps its distance from the git
 *  port and every caller reads the field through one function. */
export function buildPlaneFqdnFromMarkings(repo: PlatformRepo): BuildPlaneFqdnResolver {
  return async (cluster: string) => (await resolveClusterMarking(repo, cluster)).buildPlaneFqdn;
}

/** Mirror a marking onto the inventory rows the Controller reads at run time: the cluster's stage
 *  and its server's role. The map is the writable place; these two columns are the copy, and they
 *  are what every role/stage decision in this process actually queries. Writes an audit entry for
 *  each column it moves and returns what changed, so a divergence between the map and the DB is
 *  visible instead of silently corrected. Unknown clusters are refused rather than inserted —
 *  registering a cluster is deploy-slave's job, not a side effect of reading a file. */
export function projectClusterMarking(
  db: Db,
  marking: ClusterMarking,
  opts: { actor: string; runId?: string },
): { stage?: { from: Stage; to: Stage }; role?: { from: ServerRole; to: ServerRole } } {
  const row = db
    .select({ clusterId: clusters.id, stage: clusters.stage, serverId: servers.id, role: servers.role })
    .from(clusters)
    .innerJoin(servers, eq(clusters.serverId, servers.id))
    .where(eq(clusters.domain, marking.fqdn))
    .get();
  if (!row) throw errValidation(`no cluster registered for ${marking.fqdn} — nothing to project the cluster map onto`);

  const changed: { stage?: { from: Stage; to: Stage }; role?: { from: ServerRole; to: ServerRole } } = {};
  if (row.stage !== marking.stage) {
    db.update(clusters).set({ stage: marking.stage }).where(eq(clusters.id, row.clusterId)).run();
    changed.stage = { from: row.stage, to: marking.stage };
  }
  if (row.role !== marking.role) {
    db.update(servers).set({ role: marking.role }).where(eq(servers.id, row.serverId)).run();
    changed.role = { from: row.role, to: marking.role };
  }
  if (changed.stage || changed.role) {
    writeAudit(db, {
      actor: opts.actor,
      action: "cluster.marking_projected",
      targetKind: "cluster",
      targetId: row.clusterId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      detail: { fqdn: marking.fqdn, ...changed },
    });
  }
  return changed;
}

/** The fields that make a cluster a REACHABLE slave: its master and the endpoint the master's
 *  in-cluster components dial its kube-apiserver on. install.sh writes them at install time;
 *  dropping them again is the one map mutation the Controller makes, and it is what takes a cluster
 *  out of the slaves ApplicationSet. */
const SLAVE_PART_KEYS = ["master", "apiHost", "apiPort"] as const;

/** Serialize a marking back to the map file. EXPORTED because the map now has two places to be:
 *  commitMarking puts it on the books branch, where the slaves ApplicationSet generator reads it,
 *  and deploy-slave's prepare-branch needs the same bytes on the SLAVE's own branch, where
 *  set-role.sh reads them. One writer, two destinations — composing the file a second time in shell
 *  is how the two would drift.
 *
 *  Serialize a marking back to the map file. Emitted key by key in a fixed order rather than dumped
 *  from an object, so a value can never carry a newline or a colon into a neighbouring field, and
 *  re-parsed before it is handed back — a map that does not read back as the marking it was built
 *  from is never committed. The file's comments are NOT preserved: the map is generated, and the
 *  contract it obeys is documented at the top of this module, not in each copy of the file. */
export function serializeMarking(m: ClusterMarking): string {
  const fields: [string, string | number][] = [
    ["fqdn", m.fqdn],
    ["stage", m.stage],
    ["role", m.role],
    ["build-plane", m.buildPlaneFqdn],
    ...(m.release !== undefined ? ([["release", m.release]] as [string, string][]) : []),
    ...(m.master !== undefined ? ([["master", m.master]] as [string, string][]) : []),
    ...(m.apiHost !== undefined ? ([["apiHost", m.apiHost]] as [string, string][]) : []),
    ...(m.apiPort !== undefined ? ([["apiPort", m.apiPort]] as [string, number][]) : []),
    ...(m.unitApex !== undefined ? ([["unit-apex", m.unitApex]] as [string, string][]) : []),
    ...(m.platformDomain !== undefined ? ([["platform-domain", m.platformDomain]] as [string, string][]) : []),
    ...(m.alertRecipients !== undefined ? ([["alert-recipients", m.alertRecipients]] as [string, string][]) : []),
    ...(m.postUrl !== undefined ? ([["post-url", m.postUrl]] as [string, string][]) : []),
    ...(m.catalogRepo !== undefined ? ([["catalog-repo", m.catalogRepo]] as [string, string][]) : []),
  ];
  // PLAIN scalars, the shape install.sh write_map emits — the other writer of this file. Quoting
  // parses identically but shows every line as changed in the diff of a map's first release, which
  // hides the one line that did change. A value that would not survive plain (a leading indicator, a
  // "key: value" ambiguity) is quoted instead, and the round-trip below proves the choice per value.
  // A colon alone is fine in a YAML plain scalar (https://... is the case that matters here); what
  // makes it ambiguous is ": " — the key separator — or a " #" comment start. Anything else, or a
  // value not starting alphanumeric, is quoted rather than reasoned about.
  const scalar = (v: string | number): string =>
    typeof v === "number" || (/^[A-Za-z0-9]/.test(v) && !/: | #/.test(v)) ? String(v) : JSON.stringify(v);
  const body = fields.map(([k, v]) => `${k}: ${scalar(v)}`).join("\n") + "\n";
  // The file's own explanation, given back. install.sh writes ~25 lines above the fields and
  // documents the file as hand-editable; without this the first release pin deletes the only thing
  // that says how to edit it.
  const yaml = m.header === undefined ? body : `${m.header}\n${body}`;
  const reparsed = foldMarking(clusterMarkingPath(m.fqdn), parseYaml(yaml), yaml);
  if (!sameMarking(reparsed, m)) {
    throw new AppError("INTERNAL", `cluster map serialize round-trip diverged for ${m.fqdn}`);
  }
  return yaml;
}

/** Do two markings state the same thing? Compared by CONTENT, never by the order the keys happen to
 *  have been assigned in: the round-trip guard asks whether the file reads back as the marking it was
 *  built from, and a key's insertion order is not part of that question. Letting it be one makes a
 *  perfectly correct write fail the moment a field is added anywhere but at the end of the object. */
function sameMarking(a: ClusterMarking, b: ClusterMarking): boolean {
  // `header` is out: it is the file's own explanation, not a fact about the cluster, and the
  // round-trip below reparses a body that carries no comments — comparing it would fail every write.
  const canon = (m: ClusterMarking): string =>
    JSON.stringify(Object.entries(m).filter(([k]) => k !== "header").sort(([x], [y]) => x.localeCompare(y)));
  return canon(a) === canon(b);
}

/** What a map write commits, so both writers below produce the same shape. */
interface MarkingCommit {
  marking: ClusterMarking;
  message: string;
}

async function commitMarking(repo: PlatformRepo, c: MarkingCommit): Promise<{ commit: string }> {
  return repo.withBranch(repo.booksBranch, (books) =>
    books.commit({
      message: c.message,
      write: [{ path: clusterMarkingPath(c.marking.fqdn), content: serializeMarking(c.marking) }],
    }),
  );
}

/** Write the release pin: the cluster now stands on `tag`. The ONE declarative place the platform
 *  version of a cluster is stated, so the branch regeneration that follows has a single thing to read.
 *  Returns the marking as it stands afterwards, and `changed:false` when the map already carried this
 *  exact tag — a resumed run then re-reads its own pin instead of committing over it. */
export async function setClusterRelease(
  repo: PlatformRepo,
  fqdn: string,
  tag: string,
  runId: string,
): Promise<{ marking: ClusterMarking; changed: boolean }> {
  const current = await resolveClusterMarking(repo, fqdn);
  if (current.release === tag) return { marking: current, changed: false };
  const pinned: ClusterMarking = { ...current, release: tag };
  await commitMarking(repo, {
    marking: pinned,
    message: `release(clusters): pin ${current.name} to ${tag} [${runId}]`,
  });
  return { marking: pinned, changed: true };
}

/** The inverse: drop the slave part, leaving the cluster marked but unreachable — the master's
 *  slaves ApplicationSet stops generating for it, which IS the teardown of its management plane.
 *  The map itself STAYS: the cluster still has a role, a stage and a build plane. Tolerates an
 *  absent map and an already-stripped one, so it is safe as a compensating action. */
export async function removeSlaveMarkingPart(
  repo: PlatformRepo,
  fqdn: string,
  runId: string,
): Promise<{ changed: boolean }> {
  const { byFqdn } = await indexMarkings(repo);
  const current = byFqdn.get(fqdn);
  if (!current) return { changed: false };
  if (SLAVE_PART_KEYS.every((k) => current[k] === undefined)) return { changed: false };
  const stripped: ClusterMarking = { ...current };
  for (const k of SLAVE_PART_KEYS) delete stripped[k];
  await commitMarking(repo, {
    marking: stripped,
    message: `revert(clusters): drop the slave part of ${current.name}'s map [${runId}]`,
  });
  return { changed: true };
}
