// relocation-jobs.ts — the PURE job algebra of move/backup/restore: every dump, listing,
// restore and clear runs as an in-cluster Job of the pinned dbtools image (ClusterReader.runJob),
// because that is where the databases are reachable and the Manager carries no database clients.
// This module only COMPOSES JobSpecs — no IO — so what each phase touches is readable and testable
// in one place.
//
// WHY SEVERAL JOBS PER PHASE: a pod can only reference Secrets in its OWN namespace, and the stores
// of one unit live behind different Secrets in different namespaces — the platform Mongo root in
// `mongodb`, a tenant's bucket key in an app member namespace, a consumer's claim Secrets in its own
// namespace. So a phase is a LIST of jobs, each placed where its credentials are.
//
// THE STAGING AREA: every job reaches the Hetzner Storage Box as the rclone remote `box:` (SFTP). A
// dump writes a NEW generation, `<installation>/<stage>/<tenants|consumers>/<unit>/<generation>/`
// (generationFolder), and nothing overwrites or deletes one but retention: a backup keeps it, a
// restore reads the one the operator picked, a move restores from the one it just took and keeps it.
//
// EVERY credential a job needs rides as secretKeyRef, the box credential included. The database ones
// are already on the cluster; the box one is not — it comes from the Manager's own env
// (secret/<stage>/app/storage-box via ESO) — so runRelocationJob places it as a Secret in the job's
// own namespace for the length of the run and deletes it again. Writing it flat as `value:` instead
// would put the platform's box password into the Job object and into the pod that Job renders, in a
// unit's OWN namespace, for the Job's TTL beyond the run.
import type { JobEnvVar, JobSpec } from "#core/server/adapters/kube/port.ts";
import type { Stage } from "#core/shared/enums.ts";

export interface StorageBoxAccess {
  host: string;
  user: string;
  password: string;
}

/** ONE job of a relocation phase, placed in the namespace whose Secrets it needs. */
export interface RelocationJob {
  namespace: string;
  spec: JobSpec;
}

/** The platform Mongo of one stage, as every in-cluster client dials it (the same coordinates the
 *  service-provisioner uses). The root credential Secret lives beside it. */
export const MONGO_NAMESPACE = "mongodb";
export const MONGO_ROOT_SECRET = { name: "mongodb-credentials", key: "root-password" } as const;
export function mongoHost(stage: Stage): string {
  return `mongodb-${stage}-headless.mongodb.svc.cluster.local:27017`;
}

/** The UTC moment a generation is taken, as its folder names it — `YYYYMMDDTHHMMSSZ`, the form the
 *  machine backup names its directories in (hostyour-cloud lifecycle/master-backup-driver.sh). */
export function generationId(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Where ONE generation of a unit's backup stands below the box root: everything of an installation
 *  under its FQDN, beside its machine backups in `<installation>/master/`, and the units by their own
 *  stage and kind (hostyour-cloud#254). */
export function generationFolder(g: { installation: string; stage: Stage; kind: "tenant" | "consumer"; unit: string; generation: string }): string {
  return `${g.installation}/${g.stage}/${g.kind}s/${g.unit}/${g.generation}`;
}

/** A Job name: `reloc-<purpose>-<unit>`, bounded to the DNS-label limit. Stable per unit+purpose so
 *  a crash-resumed step re-runs the SAME job (runJob replaces a leftover of the name). */
export function relocationJobName(purpose: string, unit: string): string {
  return `reloc-${purpose}-${unit}`.slice(0, 63).replace(/-+$/, "");
}

/** The Secret carrying the box credential for ONE job, named after that job. Per-job and not one
 *  shared name, because the `mongodb` namespace hosts the jobs of EVERY unit: a second unit relocating
 *  at the same time would otherwise reap the Secret out from under the first unit's starting pod, and
 *  a non-optional secretKeyRef leaves that pod unable to start at all. */
export const boxSecretName = (jobName: string): string => `${jobName}-box`;

/** The three variables BOX_REMOTE reads. They are the Secret's keys AND the container's env names at
 *  once, so nothing translates between the two; boxSecretData is typed on this list, which is what
 *  makes a key that no longer matches a compile error rather than a job that starts without a value. */
const BOX_KEYS = ["STORAGE_BOX_HOST", "STORAGE_BOX_USER", "STORAGE_BOX_PASSWORD"] as const;

/** The box credential as the Secret's data — what runRelocationJob places for the length of a job. */
export const boxSecretData = (box: StorageBoxAccess): Record<(typeof BOX_KEYS)[number], string> => ({
  STORAGE_BOX_HOST: box.host,
  STORAGE_BOX_USER: box.user,
  STORAGE_BOX_PASSWORD: box.password,
});

/** The name and env of a job that reaches the box, composed TOGETHER because the Secret is named
 *  after the job: deriving the two in one place is what stops a builder from renaming its job and
 *  leaving the env pointing at a Secret nobody places. `alsoEnv` is whatever else the job reads —
 *  always cluster-side secretKeyRefs, which need no placing. */
export function boxSpec(purpose: string, unit: string, alsoEnv: readonly JobEnvVar[] = []): { name: string; env: JobEnvVar[] } {
  const name = relocationJobName(purpose, unit);
  return { name, env: [...BOX_KEYS.map((key) => ({ name: key, secretKeyRef: { name: boxSecretName(name), key } })), ...alsoEnv] };
}

/** Does this spec read its box credential Secret? Derived from the spec itself rather than a flag the
 *  builders would have to set, so a job that references the Secret always gets it placed and a job
 *  that does not never has one written into its namespace. */
export const jobReadsBoxSecret = (spec: JobSpec): boolean =>
  (spec.env ?? []).some((e) => e.secretKeyRef?.name === boxSecretName(spec.name));

// The rclone remote `box:` — SFTP onto the storage box, configured from the env above. Every script
// that touches the staging area starts with this.
export const BOX_REMOTE = `export RCLONE_CONFIG_BOX_TYPE=sftp
export RCLONE_CONFIG_BOX_HOST="$STORAGE_BOX_HOST"
export RCLONE_CONFIG_BOX_USER="$STORAGE_BOX_USER"
export RCLONE_CONFIG_BOX_PASS="$(rclone obscure "$STORAGE_BOX_PASSWORD")"
`;

// Mongo flags shared by every mongodb-namespace script ($MONGO_HOST/$MONGO_ROOT_PASSWORD env).
export const MONGO_FLAGS = `--host "$MONGO_HOST" --username root --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin`;

export const mongoEnv = (stage: Stage): JobEnvVar[] => [
  { name: "MONGO_HOST", value: mongoHost(stage) },
  { name: "MONGO_ROOT_PASSWORD", secretKeyRef: MONGO_ROOT_SECRET },
];

/** Print the names of every database with `prefix` as `DB <name>` lines — the wire format every
 *  listing job answers through and parseDbLines reads back. */
export const listMongoDbs = (prefix: string): string =>
  `mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' | { grep "^${prefix}" || true; } | while read -r d; do echo "DB $d"; done`;

/** The `DB <name>` lines of a listing job's log, in order — how a step reads a database listing. */
export function parseDbLines(logs: string): string[] {
  return logs
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("DB "))
    .map((l) => l.slice(3));
}

/** Write `content` to a file heredoc-safe (the registration is flat "key: <json>" YAML — no line of
 *  it can collide with the terminator). */
export const writeFile = (path: string, content: string): string => `cat > ${path} <<'RELOC_EOF'\n${content}\nRELOC_EOF\n`;

// ---- Shared jobs ---------------------------------------------------------------------------

/** Quote a name list for a sh word list. */
export const quoted = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(" ");

/** Print a `SHA256 <hash>  <path>` line for a file a job is about to carry to the box: `local` is where
 *  it stands in the pod, `path` where it goes inside the generation. Both may name shell variables of
 *  the job's own loop. The dump step collects these lines into the generation's manifest. */
export const hashLine = (local: string, path: string): string => `echo "SHA256 $(sha256sum "${local}" | cut -d' ' -f1)  ${path}"\n`;

/** The `sha256  path` lines of a job's log, in order — what hashLine printed. */
export function parseSha256Lines(logs: string): string[] {
  return logs
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^SHA256 [0-9a-f]{64}  /.test(l))
    .map((l) => l.slice("SHA256 ".length));
}

/** The manifest.txt of one generation: what it is, then one `sha256  path` line per file a dump job
 *  hashed — the form the machine backup's manifest has, which `sha256sum -c` reads inside the folder.
 *  A bucket is synced object by object and carries no line of its own. */
export function generationManifest(g: { unit: string; kind: string; stage: Stage; generation: string; trigger: string; runId: string | null; installation: string; stores: readonly string[] }, sums: readonly string[]): string {
  return [
    `INSTALLATION=${g.installation}`,
    `KIND=${g.kind}`,
    `UNIT=${g.unit}`,
    `STAGE=${g.stage}`,
    `GENERATION=${g.generation}`,
    `TRIGGER=${g.trigger}`,
    `RUN=${g.runId ?? "-"}`,
    `STORES=${g.stores.join(",")}`,
    ...sums,
  ].join("\n");
}

/** Lay the manifest into the generation, as its last file. */
export function writeManifestJob(i: { unit: string; folder: string; namespace: string; manifest: string; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("manifest", i.unit),
      image: i.image,
      script: BOX_REMOTE + writeFile("/tmp/manifest.txt", i.manifest) + `rclone copyto /tmp/manifest.txt "box:${i.folder}/manifest.txt"\n`,
    },
  };
}

/** Delete ONE generation from the box — a failed one, or one retention drops. A folder that is not
 *  there is the idempotent no-op; any other failure of the delete fails the job. */
export function purgeGenerationJob(i: { unit: string; folder: string; namespace: string; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("purge-generation", i.unit),
      image: i.image,
      script: BOX_REMOTE + `if rclone lsf "box:${i.folder}" >/dev/null 2>&1; then
  rclone purge "box:${i.folder}"
  echo "PURGED ${i.folder}"
else
  echo "ABSENT ${i.folder}"
fi
`,
    },
  };
}

/** Verify the dump: every expected entry stands in the generation's folder, or the job fails naming
 *  the missing one. Runs where the box is reachable and no cluster Secret is needed. */
export function verifyDumpJob(i: { unit: string; folder: string; namespace: string; expected: readonly string[]; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("verify-dump", i.unit),
      image: i.image,
      script:
        BOX_REMOTE +
        `for entry in ${quoted(i.expected)}; do
  [ -n "$(rclone lsf "box:${i.folder}/$entry" 2>/dev/null)" ] || { echo "MISSING $entry"; exit 1; }
  echo "PRESENT $entry"
done
`,
    },
  };
}

/** Read the dumped registration back off the box — how a restore learns what the unit WAS (its
 *  deploy group, its apps) after the live registration is long removed. The file rides the job log
 *  between two markers; readRegistrationFromLogs cuts it back out. */
export function readRegistrationJob(i: { unit: string; folder: string; namespace: string; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("read-reg", i.unit),
      image: i.image,
      script: BOX_REMOTE + `echo "REGISTRATION-BEGIN"\nrclone cat "box:${i.folder}/registration.yaml"\necho "REGISTRATION-END"\n`,
    },
  };
}

/** The registration text between the markers of a readRegistrationJob log, or null when the markers
 *  never appeared (the job failed before printing). */
export function readRegistrationFromLogs(logs: string): string | null {
  const lines = logs.split("\n");
  const begin = lines.indexOf("REGISTRATION-BEGIN");
  const end = lines.lastIndexOf("REGISTRATION-END");
  if (begin < 0 || end < 0 || end <= begin) return null;
  return lines.slice(begin + 1, end).join("\n");
}
