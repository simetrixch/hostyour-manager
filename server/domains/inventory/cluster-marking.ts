// cluster-marking.ts — THE resolution of a cluster to what the platform knows about it: its role,
// its stage, its short name and whether it carries the build plane. All four come from ONE file,
// `clusters/active/<fqdn>.yaml`. A master's map is written when the cluster is installed (the
// deployment programs' install path); a SLAVE's map is the Manager's to write — deploy-slave's
// mark-slave step, through writeClusterMarking below. No third writer exists: a copy somewhere else
// is what let maps drift away from the branches they describe.
//
// EVERY cluster's map stands on ONE branch — this installation's books (shared/branches.ts), which is
// the install branch of the cluster holding the master role, and which the platform repo port carries
// as `booksBranch`. It is the ONLY install branch an installation has: a cluster carrying only the
// slave part has none, and its machine's own checkout stands on this same branch. So a map is
// written ONCE, and the tree a slave reads its own map out of is the tree every other map stands
// in. Not the trunk either — a map names a real FQDN, a stage and a business domain, and the trunk
// is what every future installation is cut from.
//
// The map's shape, and what each field drives:
//   fqdn         the cluster's public FQDN == its install branch == clusters.domain.
//   stage        dev | test | prod. A cluster carries exactly one, and a registration for stage X
//                may only point at a cluster marked X.
//   role         master | slave | master+slave — cluster MANAGEMENT only: who operates ArgoCD,
//                Vault, identity and the build plane for whom. Never a placement rule.
//   books-cluster  the domain of the cluster that keeps the books — the cluster's own for a
//                master, the master's for a slave. The slaves ApplicationSet SELECTS on this key
//                (clusters/argocd/files/slaves-appset.yaml matchLabels), so a slave map without it is
//                invisible to the generator.
//   build-plane  the FQDN of the cluster that builds this one's images. The predicate is
//                `buildPlane := (build-plane == fqdn)`, so one field answers both "do I run the
//                build plane?" and "whose registry do I pull from?" — a cluster that builds
//                elsewhere names that other cluster here.
//   release      the platform release tag this cluster stands on, in the one release grammar
//                (shared/release.ts). Nothing in this process reads or writes it: it is written
//                outside this manager and read by the catalogue's branch regeneration program.
//                Declared and validated here so a map rewrite carries it instead of deleting it.
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
//                sender allowlist. The branch programs write it (defaulting to the unit apex).
//   endpoints.mail.url  where units reach the installation's shared mail service; absent on an
//                installation that runs none.
//   catalog-repo the <owner>/<name> of the repository holding this installation's tenant charts
//                and their per-stage pins. The branch programs demand it (nothing composes a
//                repository this cloud does not own).
//
// This module PARSES the map and REGENERATES it key by key, so every key the file may carry has to
// be declared below even where nothing here decides anything with it: a key the schema does not
// know is a key the next write deletes.
//
// The cluster SHORT NAME is NOT a field. It is derived from `fqdn` as its first label, by
// clusterShortName below — the one derivation in this repo. A stored name would be a second writer
// of the same datum, and the ApplicationSet selector that derives it from the fqdn would then match
// nothing the moment the two disagreed.
//
// Boundary: domain layer — the db schema, shared/ and the git PlatformRepo port only. Deliberately
// imports NO other domain (inventory is the base domain every other one may read, not the reverse).
import { eq } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { AppError, errValidation } from "../../kernel/errors.ts";
import { SERVER_ROLE, STAGE, type ServerRole, type Stage } from "../../../shared/enums.ts";
import { RELEASE_TAG_RE } from "../../../shared/release.ts";
import { CLUSTER_MAP_DIR, clusterMapPath } from "../../../shared/cluster-values.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The ONE derivation of a cluster's short name — the first label of its FQDN.
 *  `m1.example.com` -> `m1`. Every reader of a short name in this repo goes through here;
 *  the shell layer's `cluster_name_from_fqdn` and the ApplicationSet generators derive it the same
 *  way, so the three artifact families can never disagree about what a cluster is called. */
export function clusterShortName(fqdn: string): string {
  return fqdn.split(".")[0] || fqdn;
}

/** The map as it stands on disk. Real YAML (the file carries comments), so it is parsed with the
 *  YAML reader rather than the flat "key: <json>" pointer reader. `build-plane` is REQUIRED: the
 *  registry host and the build-plane toggles are derived from it with no case distinction, so a map
 *  without it cannot be rendered at all — failing loud here names the file to fix.
 *
 *  STRICT, and that is the load-bearing part. Zod's default is to STRIP a key it does not declare;
 *  serializeMarking then regenerates the whole file from what survived, so an undeclared key is
 *  silently deleted from git by the next map write — a write nobody asked for, on a file whose
 *  own header documents it as hand-editable. Strict turns that into an error naming the file and the key, which is
 *  also the whole migration path for a renamed field: a map still carrying the retired `lanHost` is
 *  refused out loud instead of quietly losing the only git-side record of where the master dials the
 *  slave. One unreadable map fails every read, because indexMarkings folds them all — the same blast
 *  radius the slaves ApplicationSet has under missingkey=error, and for the same reason. */
const ClusterMarkingFileSchema = z.object({
  stage: z.enum(STAGE),
  role: z.enum(SERVER_ROLE),
  // Optional because maps predating the key are still valid markings; every map the deployment
  // programs write (cluster-map.tpl) and every slave map mark-slave writes carries it.
  booksCluster: z.string().min(1).optional(),
  // Carried, never read or written by this process — the catalogue's branch regeneration program
  // reads it. Checked against the release grammar rather than accepted as free text: the field IS a
  // pin, and a value the grammar does not recognise names no state anything can be regenerated from.
  release: z.string().regex(RELEASE_TAG_RE, "must be a release tag <x.y.z>-<channel>-<ts14>").optional(),
  // THE TOP LEVEL IS WHAT THE GENERATORS SELECT ON, and it is strict for that reason: a key that
  // does not belong there is a key nothing selects on, and a selector matching nothing produces no
  // Applications and reports no error at all. Everything a CHART reads lives under `global` instead,
  // where the same file is also a Helm values file — one file, two readers, which is what ended an
  // installation's answers being written down twice in two spellings.
  global: z.object({
    domain: z.string().min(1),
    buildPlane: z.string().min(1),
    master: z.string().min(1).optional(),
    apiHost: z.string().min(1).optional(),
    apiPort: z.number().int().positive().optional(),
    // Nothing in this process decides anything with these five. They are declared and carried so a
    // write does not drop them; optional rather than required because the maps that predate them
    // are still valid markings.
    unitApex: z.string().min(1).optional(),
    platformDomain: z.string().min(1).optional(),
    alertRecipients: z.union([z.string(), z.array(z.string())]).optional(),
    catalogUrl: z.string().min(1).optional(),
    // THE ONE AUTHORITY OF THIS INSTALLATION, the mailbox it writes to, and WHICH authority issues
    // at all. Read rather than merely carried: a machine added to an installation later is told them
    // from here instead of being asked for them again, because they are the installation's answer
    // and not the machine's. Absent, a regeneration is told nothing about the authority and the
    // answer falls to the program's default of platform-local, which reissues every certificate
    // from the cluster's own root.
    clusterIssuer: z.string().min(1).optional(),
    letsencryptEmail: z.string().min(1).optional(),
    letsencryptServer: z.string().min(1).optional(),
    endpoints: z.object({}).passthrough().optional(),
  // PASSTHROUGH, and only here. The global block carries every value the charts of this platform
  // read, and this process has no business refusing a key a chart added — it would fail every map
  // read on the next release that introduces one. What it does refuse is an unknown key at the TOP,
  // which is the surface it actually decides on.
  }).passthrough(),
}).strict();

/** Every key the strict schema accepts — its whole surface. The deployment programs' map template
 *  (hostyour-deploy ansiwise/templates/cluster-map.tpl) is the OTHER writer, so the test suite
 *  compares this list against the keys that template emits: a field the template gains fails ONE
 *  test naming the key, instead of failing every map read on the next fresh installation. */
export const CLUSTER_MARKING_FILE_KEYS = Object.keys(ClusterMarkingFileSchema.shape);

/** One cluster's marking, with the derived facts folded in. */
export interface ClusterMarking {
  /** The comment block the file opens with, VERBATIM, so a rewrite gives it back. The map
   *  template writes a header above the fields — what the file is and who writes it — and the file
   *  is hand-editable. Without carrying this, the first map rewrite would delete the only thing
   *  that says how to edit it. NOT identity: sameMarking ignores it. */
  header?: string;
  fqdn: string;
  /** clusterShortName(fqdn) — derived, never read from the file. */
  name: string;
  role: ServerRole;
  stage: Stage;
  /** The domain of the cluster that keeps the books — the slaves ApplicationSet's selector key. */
  booksCluster?: string;
  /** Does this cluster RUN the build plane? True exactly when `build-plane` names itself. */
  buildPlane: boolean;
  /** The FQDN of the cluster that builds this one's images (own fqdn when buildPlane). */
  buildPlaneFqdn: string;
  /** The platform release tag the cluster stands on. Carried, never read or written here — it is
   *  written outside this manager and read by the catalogue's branch regeneration program. */
  release?: string;
  master?: string;
  apiHost?: string;
  apiPort?: number;
  /** Carried, never read here — see the schema note on why an undeclared key is a deleted key. */
  unitApex?: string;
  /** Carried, never read here. */
  platformDomain?: string;
  /** Carried, never read here — and carried as a LIST, which is the shape the map template writes
   *  and the shape the alert route iterates. Joined to one string it became one mailbox that is
   *  several, and the render of the whole observability application stopped at
   *  `range can't iterate over ...`. */
  alertRecipients?: string[];
  /** Carried, never read here. */
  mailUrl?: string;
  /** Carried, never read here. */
  catalogRepo?: string;
  /** Which authority issues this installation's certificates, the authority it registers with, and
   *  the mailbox that one writes to. Handed to the machine-layer programs of a machine that joins
   *  later, so nobody is asked twice for one answer of the installation. */
  clusterIssuer?: string;
  letsencryptEmail?: string;
  letsencryptServer?: string;
  /** Everything `global` carried that this module does not name, carried VERBATIM. The schema lets
   *  the block through on purpose, so a chart may add a value without failing every map read on the
   *  release that introduces it - but a writer that emits only what it understands turns that
   *  permission into DATA LOSS the moment anything rewrites the file, and mark-slave rewrites it on
   *  every deploy. Every endpoint, every servicesLocal flag, the cluster's short name and its Vault
   *  auth path travel here. */
  globalRest?: Record<string, unknown>;
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

/** The keys of `global` this module states itself, and so the ones that must NOT also travel in
 *  globalRest - a key written from both would stand in the file twice. */
const NAMED_GLOBALS = new Set([
  "domain", "booksCluster", "buildPlane", "master", "apiHost", "apiPort",
  "unitApex", "platformDomain", "alertRecipients", "catalogUrl",
  "clusterIssuer", "letsencryptEmail", "letsencryptServer",
]);

function foldMarking(path: string, raw: unknown, text?: string): ClusterMarking {
  const parsed = ClusterMarkingFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw errValidation(
      `cluster map ${path} is not a valid marking: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const m = parsed.data;
  const g = m.global;
  const header = text === undefined ? undefined : headerOf(text);
  // THE OWNER/NAME OF THE CATALOGUE, derived from the URL the map carries rather than written a
  // second time beside it. The map states one thing about the catalogue — where a build clones it
  // from — and every other spelling of it follows from that one.
  const catalogRepo = g.catalogUrl?.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  // Derived, like catalogRepo: the address stands in the endpoints block, which travels whole in
  // globalRest, so reading it by name here does not make this module a second writer of it.
  const mailUrl = (g.endpoints as { mail?: { url?: string } } | undefined)?.mail?.url;
  const rest = Object.fromEntries(Object.entries(g).filter(([k]) => !NAMED_GLOBALS.has(k)));
  return {
    ...(header !== undefined ? { header } : {}),
    fqdn: g.domain,
    name: clusterShortName(g.domain),
    role: m.role,
    stage: m.stage,
    ...(m.booksCluster !== undefined ? { booksCluster: m.booksCluster } : {}),
    buildPlane: g.buildPlane === g.domain,
    buildPlaneFqdn: g.buildPlane,
    ...(m.release !== undefined ? { release: m.release } : {}),
    ...(g.master !== undefined ? { master: g.master } : {}),
    ...(g.apiHost !== undefined ? { apiHost: g.apiHost } : {}),
    ...(g.apiPort !== undefined ? { apiPort: g.apiPort } : {}),
    ...(g.unitApex !== undefined ? { unitApex: g.unitApex } : {}),
    ...(g.platformDomain !== undefined ? { platformDomain: g.platformDomain } : {}),
    // A LIST STAYS A LIST. It used to be joined on a comma here and written back as a plain scalar,
    // so the first rewrite of a map turned ['a@x', 'b@x'] into `a@x,b@x` — one mailbox that is two,
    // and a value the alert route cannot range over at all. A scalar is still accepted, because a
    // map may have been written that way before this, and it is split on the same comma.
    ...(g.alertRecipients !== undefined
      ? { alertRecipients: (Array.isArray(g.alertRecipients) ? g.alertRecipients : g.alertRecipients.split(","))
          .map((m) => m.trim()).filter((m) => m.length > 0) }
      : {}),
    ...(mailUrl !== undefined ? { mailUrl } : {}),
    ...(catalogRepo ? { catalogRepo } : {}),
    ...(g.clusterIssuer !== undefined ? { clusterIssuer: g.clusterIssuer } : {}),
    ...(g.letsencryptEmail !== undefined ? { letsencryptEmail: g.letsencryptEmail } : {}),
    ...(g.letsencryptServer !== undefined ? { letsencryptServer: g.letsencryptServer } : {}),
    ...(Object.keys(rest).length > 0 ? { globalRest: rest } : {}),
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
  for (const entry of await books.listDir(CLUSTER_MAP_DIR)) {
    if (!entry.endsWith(".yaml")) continue;
    const path = `${CLUSTER_MAP_DIR}/${entry}`;
    const text = await books.readFile(path);
    if (text === null) continue; // a directory entry, or removed between listing and reading
    const marking = foldMarking(path, parseYaml(text), text);
    const clash = byName.get(marking.name);
    if (clash) {
      throw errValidation(
        `cluster maps ${clusterMapPath(clash.fqdn)} and ${path} both derive the short name "${marking.name}" — a cluster is addressed by that name (ArgoCD instance, AppProject, Vault mount), so the two would collide; rename one cluster's first FQDN label`,
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
 *  fallback, and every install path writes the map before the cluster is ever reachable. */
export async function resolveClusterMarking(repo: PlatformRepo, cluster: string): Promise<ClusterMarking> {
  const { byFqdn, byName } = await indexMarkings(repo);
  const found = byFqdn.get(cluster) ?? byName.get(cluster);
  if (!found) {
    throw errValidation(
      `no cluster map for "${cluster}" — expected ${clusterMapPath(cluster)} on ${repo.booksBranch}; every cluster is marked when it is installed (the branch programs for a master, mark-slave for a slave), so a missing map means the install never completed or the map was removed by hand`,
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

/** Mirror a marking onto the inventory rows the Manager reads at run time: the cluster's stage
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

/** The fields that make a cluster a REACHABLE slave: its master, the endpoint the master's
 *  in-cluster components dial its kube-apiserver on, and the books-cluster key the slaves
 *  ApplicationSet selects on. mark-slave writes them; dropping them again is what takes a cluster
 *  out of the generator — books-cluster included, because a map still carrying the selector key
 *  without the endpoint would make the generated Application error instead of disappear. */
const SLAVE_PART_KEYS = ["master", "apiHost", "apiPort", "booksCluster"] as const;

/** Serialize a marking back to the map file — commitMarking's own writer.
 *  Emitted key by key in a fixed order rather than dumped
 *  from an object, so a value can never carry a newline or a colon into a neighbouring field, and
 *  re-parsed before it is handed back — a map that does not read back as the marking it was built
 *  from is never committed. The file's comments are NOT preserved: the map is generated, and the
 *  contract it obeys is documented at the top of this module, not in each copy of the file. */
function serializeMarking(m: ClusterMarking): string {
  // TWO BLOCKS, THE SHAPE THE MAP TEMPLATE EMITS — the other writer of this file. The top level is
  // what the generators select on and cannot be nested; everything a chart reads stands under
  // `global`, where the same file is a Helm values file. A field written into the wrong block is a
  // selector that matches nothing or a value no chart can see, and neither says so.
  const fields: [string, string | number][] = [
    ["stage", m.stage],
    ["role", m.role],
    ...(m.booksCluster !== undefined ? ([["booksCluster", m.booksCluster]] as [string, string][]) : []),
    ...(m.release !== undefined ? ([["release", m.release]] as [string, string][]) : []),
  ];
  // A value the caller has already written AS YAML — `scalar` below would quote it into a string.
  const asYaml = (yaml: string): { yaml: string } => ({ yaml });
  const globals: [string, string | number | { yaml: string }][] = [
    ["domain", m.fqdn],
    ["buildPlane", m.buildPlaneFqdn],
    ...(m.booksCluster !== undefined ? ([["booksCluster", m.booksCluster]] as [string, string][]) : []),
    ...(m.master !== undefined ? ([["master", m.master]] as [string, string][]) : []),
    ...(m.apiHost !== undefined ? ([["apiHost", m.apiHost]] as [string, string][]) : []),
    ...(m.apiPort !== undefined ? ([["apiPort", m.apiPort]] as [string, number][]) : []),
    ...(m.unitApex !== undefined ? ([["unitApex", m.unitApex]] as [string, string][]) : []),
    ...(m.platformDomain !== undefined ? ([["platformDomain", m.platformDomain]] as [string, string][]) : []),
    // NOT through `scalar` below: this one is a LIST, in the flow shape the map template writes it
    // in, so the two writers of this file put the same value down the same way. Single-quoted for
    // the reason the template states — a mailbox is one word to YAML only by accident, and a plain
    // scalar beginning with # is a comment.
    ...(m.alertRecipients !== undefined && m.alertRecipients.length > 0
      ? ([["alertRecipients", asYaml(`[${m.alertRecipients.map((r) => `'${r.replaceAll("'", "''")}'`).join(", ")}]`)]] as [string, { yaml: string }][])
      : []),
    ...(m.catalogRepo !== undefined
      ? ([["catalogUrl", `https://github.com/${m.catalogRepo}.git`]] as [string, string][])
      : []),
    // READ AND THEREFORE WRITTEN. A key this module names but does not emit is a key that survives
    // being read and vanishes on the next write — and the round-trip below is what caught it, which
    // is the whole reason that check stands here.
    ...(m.clusterIssuer !== undefined ? ([["clusterIssuer", m.clusterIssuer]] as [string, string][]) : []),
    ...(m.letsencryptEmail !== undefined ? ([["letsencryptEmail", m.letsencryptEmail]] as [string, string][]) : []),
    ...(m.letsencryptServer !== undefined ? ([["letsencryptServer", m.letsencryptServer]] as [string, string][]) : []),
  ];
  // PLAIN scalars, the shape the map template emits — the other writer of this file. Quoting
  // parses identically but shows every line as changed in the diff of a map's first rewrite, which
  // hides the one line that did change. A value that would not survive plain (a leading indicator, a
  // "key: value" ambiguity) is quoted instead, and the round-trip below proves the choice per value.
  // A colon alone is fine in a YAML plain scalar (https://... is the case that matters here); what
  // makes it ambiguous is ": " — the key separator — or a " #" comment start. Anything else, or a
  // value not starting alphanumeric, is quoted rather than reasoned about.
  const scalar = (v: string | number | { yaml: string }): string =>
    typeof v === "object" ? v.yaml
      : typeof v === "number" || (/^[A-Za-z0-9]/.test(v) && !/: | #/.test(v)) ? String(v) : JSON.stringify(v);
  // EVERYTHING ELSE THE BLOCK CARRIED, given back as it came. Nested values - the endpoints, the
  // servicesLocal flags - are handed to the YAML writer rather than assembled here: the
  // fixed-order emission above exists so a SCALAR cannot carry a colon into its neighbour, and
  // that reasoning does not extend to a tree. Left out, this is silent data loss and not a
  // failure; the round-trip guard below catches it now, because the marking states these keys.
  const nested =
    m.globalRest === undefined || Object.keys(m.globalRest).length === 0
      ? ""
      : stringifyYaml(m.globalRest, { indent: 2 })
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => `  ${l}`)
          .join("\n") + "\n";
  const body =
    fields.map(([k, v]) => `${k}: ${scalar(v)}`).join("\n") +
    "\n\nglobal:\n" +
    globals.map(([k, v]) => `  ${k}: ${scalar(v)}`).join("\n") +
    "\n" +
    nested;
  // The file's own explanation, given back — the map template writes a header above the fields and
  // the file is hand-editable; without this the first rewrite deletes the only thing that says how
  // to edit it.
  const yaml = m.header === undefined ? body : `${m.header}\n${body}`;
  const reparsed = foldMarking(clusterMapPath(m.fqdn), parseYaml(yaml), yaml);
  const differing = markingDifferences(reparsed, m);
  if (differing.length > 0) {
    throw new AppError("INTERNAL", `cluster map serialize round-trip diverged for ${m.fqdn} on ${differing.join("; ")}`);
  }
  return yaml;
}

/** Do two markings state the same thing? Compared by CONTENT, never by the order the keys happen to
 *  have been assigned in: the round-trip guard asks whether the file reads back as the marking it was
 *  built from, and a key's insertion order is not part of that question. Letting it be one makes a
 *  perfectly correct write fail the moment a field is added anywhere but at the end of the object. */
/** The fields on which a marking and its reparse disagree, each with both sides — empty when they
 *  agree.
 *
 *  IT NAMES THEM because the guard that uses it used to say only that a map "diverged", and a
 *  writer reading that has to bisect the serializer to find out which of seventeen keys moved.
 *
 *  `header` is out: it is the file's own explanation, not a fact about the cluster, and the
 *  round-trip reparses a body that carries no comments — comparing it would fail every write. */
function markingDifferences(a: ClusterMarking, b: ClusterMarking): string[] {
  const of = (m: ClusterMarking): Map<string, string> =>
    new Map(Object.entries(m).filter(([k]) => k !== "header").map(([k, v]) => [k, JSON.stringify(v)]));
  const [left, right] = [of(a), of(b)];
  const differing: string[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if (left.get(key) !== right.get(key)) {
      differing.push(`${key}: written ${right.get(key) ?? "(absent)"}, read back ${left.get(key) ?? "(absent)"}`);
    }
  }
  return differing.sort();
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
      write: [{ path: clusterMapPath(c.marking.fqdn), content: serializeMarking(c.marking) }],
    }),
  );
}

/** Write ONE cluster's whole map onto the books branch — deploy-slave's mark-slave step, the
 *  writer that puts a slave into the slaves ApplicationSet's world. What the caller does not
 *  state is KEPT from the standing file: the header (the file's own explanation), the release pin
 *  (a key this manager never writes) and the mail service's address (install-time), so marking a
 *  slave again never deletes what another writer recorded. Commits only when the marking actually
 *  changed, so a redeploy re-running the step converges instead of committing over itself. */
export async function writeClusterMarking(
  repo: PlatformRepo,
  marking: ClusterMarking,
  runId: string,
): Promise<{ changed: boolean }> {
  const { byFqdn } = await indexMarkings(repo);
  const current = byFqdn.get(marking.fqdn);
  const next: ClusterMarking = {
    ...marking,
    ...(current?.header !== undefined ? { header: current.header } : {}),
    ...(current?.release !== undefined ? { release: current.release } : {}),
    ...(current?.mailUrl !== undefined && marking.mailUrl === undefined ? { mailUrl: current.mailUrl } : {}),
  };
  if (current && markingDifferences(current, next).length === 0) return { changed: false };
  await commitMarking(repo, {
    marking: next,
    message: `deploy(clusters): mark ${next.name} (${next.role}, ${next.stage}) [${runId}]`,
  });
  return { changed: true };
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
