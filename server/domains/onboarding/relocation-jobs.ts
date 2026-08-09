// relocation-jobs.ts — the PURE job algebra of move/backup/restore: every dump, listing,
// restore and clear runs as an in-cluster Job of the pinned dbtools image (ClusterReader.runJob),
// because that is where the databases are reachable and the Controller carries no database clients.
// This module only COMPOSES JobSpecs — no IO — so what each phase touches is readable and testable
// in one place.
//
// WHY SEVERAL JOBS PER PHASE: a pod can only reference Secrets in its OWN namespace, and the stores
// of one unit live behind different Secrets in different namespaces — the platform Mongo root in
// `mongodb`, a tenant's bucket key in an app member namespace, a consumer's claim Secrets in its own
// namespace. So a phase is a LIST of jobs, each placed where its credentials are.
//
// THE STAGING AREA: every job reaches the Hetzner Storage Box as the rclone remote `box:` (SFTP),
// under ONE folder named after the unit — keep the folder and the run was a backup, restore from it
// and it was a restore, delete it at the end and it was a move.
//
// EVERY credential a job needs rides as secretKeyRef, the box credential included. The database ones
// are already on the cluster; the box one is not — it comes from the Controller's own env
// (secret/<stage>/app/storage-box via ESO) — so runRelocationJob places it as a Secret in the job's
// own namespace for the length of the run and deletes it again. Writing it flat as `value:` instead
// would put the platform's box password into the Job object and into the pod that Job renders, in a
// unit's OWN namespace, for the Job's TTL beyond the run.
import type { JobEnvVar, JobSpec } from "../../adapters/kube/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import { memberNamespace } from "./tenant-fanout.ts";

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

/** The tenant crypto Secret every member kit materializes from the tenant's Vault entry, and the
 *  bucket-scoped key Secret only app members (the engine) carry. */
export const TENANT_CRYPTO_SECRET = "hostyour-app-secrets";
export const TENANT_S3_SECRET = "hostyour-tenant-s3";

/** What the S3_REMOTE block needs in a tenant app member namespace. EVERY value comes off the
 *  tenant's own bucket Secret, the endpoint included — there is no cluster constant to fall back on
 *  any more: Garage left the cloud base, and a tenant's store is whatever provisioned that Secret.
 *  Shared by the dump, the restore and the completeness listing, which all reach the same bucket. */
const tenantS3Env = (): JobEnvVar[] => [
  { name: "S3_ENDPOINT", secretKeyRef: { name: TENANT_S3_SECRET, key: "UPLOAD_S3_ENDPOINT" } },
  { name: "S3_ACCESS_KEY", secretKeyRef: { name: TENANT_S3_SECRET, key: "UPLOAD_S3_KEY" } },
  { name: "S3_SECRET_KEY", secretKeyRef: { name: TENANT_S3_SECRET, key: "UPLOAD_S3_SECRET" } },
];
/** The Vault properties of the tenant's crypto material that the IdP member's OWN Secret carries,
 *  dumped one FILE per property under vault/ — byte-exact, so proof and restore compare files, never
 *  re-encoded blobs.
 *
 *  FOUR of the entry's five, and the split is a namespace fact rather than a choice: these four are
 *  the app Secret (example-lib's secretKit renders it wherever a chart declares appSecretName), and the
 *  fifth — the engine key — is rendered only where it is READ, which is the jobs and engine members,
 *  never the IdP's. A dump job can only read a Secret in its own namespace, so the fifth has its own
 *  job in TENANT_ENGINE_KEY below. */
export const TENANT_CRYPTO_KEYS = [
  { env: "AUTH_JWT_PRIVATE_KEY", property: "auth-jwt-private-key" },
  { env: "AUTH_JWT_PUBLIC_KEY", property: "auth-jwt-public-key" },
  { env: "AUTH_TOTP_ENC_KEY", property: "auth-totp-enc-key" },
  { env: "AUTH_BOOTSTRAP_TOKEN", property: "auth-bootstrap-token" },
] as const;

/** The fifth property of the same Vault entry, and the fifth file under vault/: the trusted-service
 *  key the tenant's jobs presents and its engine verifies. It lives in a DIFFERENT Kubernetes Secret
 *  (example-engine-api-key, rendered by the kit for exactly the two members that read it), so it is
 *  dumped by its own job in an app member's namespace — see tenantDumpJobs.
 *
 *  Without it a hand recovery from the box restores a tenant whose jobs and engine no longer agree on
 *  a bearer, and the failure reads as an auth error rather than as a missing backup. */
export const TENANT_ENGINE_KEY = { env: "ENGINE_API_KEY", property: "engine-api-key", secret: "example-engine-api-key", secretKey: "engine-api-key" } as const;

/** The per-consumer PostgreSQL instance coordinates (service-provisioner naming:
 *  `<claim>-<service>` with the claim named after the unit). */
export const CONSUMER_POSTGRES = { host: "postgres", secret: "postgresql-credentials", key: "postgres-password", user: "postgres" } as const;

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

// The rclone remote `s3:` against a Garage endpoint, configured from $S3_* env the caller supplies.
export const S3_REMOTE = `export RCLONE_CONFIG_S3_TYPE=s3
export RCLONE_CONFIG_S3_PROVIDER=Other
export RCLONE_CONFIG_S3_ENDPOINT="$S3_ENDPOINT"
export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
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

// ---- Tenant jobs ---------------------------------------------------------------------------

export interface TenantJobInputs {
  guid: string;
  stage: Stage;
  /** The tenant's app member names (its apps[] matrix) — where the bucket-key Secret lives. */
  apps: readonly string[];
  /** Which member is the tenant's IdP — the namespace the crypto material is read from. */
  identityProvider: string;
  image: string;
}

/** Where the tenant's bucket jobs run: the FIRST app member namespace, because only app members
 *  carry the bucket-scoped key Secret (the engine is the one member with a StoragePort). A tenant
 *  with no apps has no member that can reach the bucket — and nothing that writes it — so the bucket
 *  phase is simply absent. */
function tenantBucketNamespace(guid: string, apps: readonly string[]): string | null {
  const first = apps[0];
  return first === undefined ? null : memberNamespace(guid, first);
}

/** The complete tenant dump — EVERYTHING the unit owns: the registration, every `<guid>_*` Mongo
 *  database, the bucket, and the crypto material as one file per Vault property. */
export function tenantDumpJobs(i: TenantJobInputs & { registrationYaml: string }): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("dump-mongo", i.guid, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          writeFile("/tmp/registration.yaml", i.registrationYaml) +
          `rclone copyto /tmp/registration.yaml "box:${i.guid}/registration.yaml"
${listMongoDbs(`${i.guid}_`)} > /tmp/dbs
cat /tmp/dbs
sed 's/^DB //' /tmp/dbs | while read -r db; do
  mongodump ${MONGO_FLAGS} --db "$db" --archive="/tmp/$db.archive" --quiet
  rclone copyto "/tmp/$db.archive" "box:${i.guid}/mongo/$db.archive"
  rm -f "/tmp/$db.archive"
done
`,
      },
    },
    {
      namespace: memberNamespace(i.guid, i.identityProvider),
      spec: {
        ...boxSpec("dump-crypto", i.guid, TENANT_CRYPTO_KEYS.map((k) => ({ name: k.env, secretKeyRef: { name: TENANT_CRYPTO_SECRET, key: k.env } }))),
        image: i.image,
        script:
          BOX_REMOTE +
          TENANT_CRYPTO_KEYS.map((k) => `printf '%s' "$${k.env}" > "/tmp/${k.property}"\nrclone copyto "/tmp/${k.property}" "box:${i.guid}/vault/${k.property}"\n`).join(""),
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("dump-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script: BOX_REMOTE + S3_REMOTE + `rclone sync "s3:${i.guid}" "box:${i.guid}/bucket" --create-empty-src-dirs\n`,
      },
    });
    // The fifth crypto file, beside the other four under vault/. It runs HERE and not with them
    // because it is in a different Kubernetes Secret in a different namespace: the kit renders
    // example-engine-api-key only where it is read, which is the engine and jobs members, and a dump
    // job reads only its own namespace. An app member's namespace is where the engine is, so the same
    // namespace the bucket dump already runs in is the one that can see it.
    //
    // Bound to the SAME condition as the bucket, and that is exact rather than convenient: a tenant
    // with no apps has no engine, so nothing presents or verifies this key and there is nothing to
    // recover. The value is still minted for every tenant (the entry is one write), so a tenant that
    // later gains its first app gets it from Vault, not from the box.
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("dump-engine-key", i.guid, [
          { name: TENANT_ENGINE_KEY.env, secretKeyRef: { name: TENANT_ENGINE_KEY.secret, key: TENANT_ENGINE_KEY.secretKey } },
        ]),
        image: i.image,
        script:
          BOX_REMOTE +
          `printf '%s' "$${TENANT_ENGINE_KEY.env}" > "/tmp/${TENANT_ENGINE_KEY.property}"\n` +
          `rclone copyto "/tmp/${TENANT_ENGINE_KEY.property}" "box:${i.guid}/vault/${TENANT_ENGINE_KEY.property}"\n`,
      },
    });
  }
  return jobs;
}

/** What a complete tenant dump leaves on the box — the entries verify-dump demands. */
export function tenantExpectedDumpEntries(apps: readonly string[]): string[] {
  return ["registration.yaml", "mongo", "vault", ...(apps.length > 0 ? ["bucket"] : [])];
}

/** Restore the tenant's data into the TARGET: every dumped Mongo archive, and the bucket. The crypto
 *  material is NOT restored — Vault is one shared mount a move never touches; the target's ESO
 *  re-materializes the same entry. */
export function tenantRestoreJobs(i: TenantJobInputs): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("restore-mongo", i.guid, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `rclone lsf "box:${i.guid}/mongo/" | while read -r f; do
  rclone copyto "box:${i.guid}/mongo/$f" "/tmp/$f"
  mongorestore ${MONGO_FLAGS} --archive="/tmp/$f" --drop --quiet
  rm -f "/tmp/$f"
done
`,
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("restore-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script: BOX_REMOTE + S3_REMOTE + `rclone sync "box:${i.guid}/bucket" "s3:${i.guid}" --create-empty-src-dirs\n`,
      },
    });
  }
  return jobs;
}

/** Completeness on the TARGET (before DNS): every dumped Mongo archive has its database, and the
 *  bucket carries the same object count as the box copy. The comparison runs IN the script — the two
 *  listings live in different namespaces, so each job compares what it can see and fails with a
 *  MISSING line naming what is not there. */
export function tenantVerifyCompletenessJobs(i: TenantJobInputs): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("verify-mongo", i.guid, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `${listMongoDbs(`${i.guid}_`)} | sed 's/^DB //' > /tmp/have
rclone lsf "box:${i.guid}/mongo/" | sed 's/\\.archive$//' | while read -r want; do
  grep -qx "$want" /tmp/have || { echo "MISSING database $want"; exit 1; }
done
echo "COMPLETE mongo"
`,
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("verify-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script:
          BOX_REMOTE +
          S3_REMOTE +
          `want=$(rclone size "box:${i.guid}/bucket" --json | sed 's/.*"count":\\([0-9]*\\).*/\\1/')
have=$(rclone size "s3:${i.guid}" --json | sed 's/.*"count":\\([0-9]*\\).*/\\1/')
echo "COUNT box=$want target=$have"
[ "$want" = "$have" ] || { echo "MISSING bucket objects: box has $want, target has $have"; exit 1; }
echo "COMPLETE bucket"
`,
      },
    });
  }
  return jobs;
}

/** List the SOURCE's `<guid>_*` databases — the data half of verify-source-released: after the
 *  repoint the source must still HOLD the data (the relocating release worked), and clear-source is
 *  what may drop it, later. */
export function tenantSourceDbListJob(i: { guid: string; stage: Stage; image: string }): RelocationJob {
  return {
    namespace: MONGO_NAMESPACE,
    spec: {
      name: relocationJobName("list-source", i.guid),
      image: i.image,
      env: mongoEnv(i.stage),
      script: listMongoDbs(`${i.guid}_`) + "\n",
    },
  };
}

/** Clear the SOURCE, last: drop the `<guid>_*` databases and delete the box folder. The
 *  box purge runs from the mongodb namespace too — it only needs the box. */
export function tenantClearSourceJobs(i: { guid: string; stage: Stage; image: string }): RelocationJob[] {
  return [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("clear-source", i.guid, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `${listMongoDbs(`${i.guid}_`)} | sed 's/^DB //' | while read -r db; do
  mongosh ${MONGO_FLAGS} --quiet --eval "db.getSiblingDB('$db').dropDatabase()"
  echo "DROPPED $db"
done
rclone purge "box:${i.guid}" || true
echo "FOLDER ${i.guid} removed"
`,
      },
    },
  ];
}

// ---- Shared jobs ---------------------------------------------------------------------------

/** Quote a name list for a sh word list. */
export const quoted = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(" ");

/** Verify the dump: every expected entry stands in the unit's box folder, or the job fails naming
 *  the missing one. Runs where the box is reachable and no cluster Secret is needed. */
export function verifyDumpJob(i: { unit: string; namespace: string; expected: readonly string[]; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("verify-dump", i.unit),
      image: i.image,
      script:
        BOX_REMOTE +
        `for entry in ${quoted(i.expected)}; do
  [ -n "$(rclone lsf "box:${i.unit}/$entry" 2>/dev/null)" ] || { echo "MISSING $entry"; exit 1; }
  echo "PRESENT $entry"
done
`,
    },
  };
}

/** Read the dumped registration back off the box — how a restore learns what the unit WAS (its
 *  deploy group, its apps) after the live registration is long removed. The file rides the job log
 *  between two markers; readRegistrationFromLogs cuts it back out. */
export function readRegistrationJob(i: { unit: string; namespace: string; image: string }): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("read-reg", i.unit),
      image: i.image,
      script: BOX_REMOTE + `echo "REGISTRATION-BEGIN"\nrclone cat "box:${i.unit}/registration.yaml"\necho "REGISTRATION-END"\n`,
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
