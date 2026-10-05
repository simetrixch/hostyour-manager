// The tenant's jobs of move/backup/restore: its registration, its `<guid>_*` Mongo databases, its
// bucket and its crypto material, each job placed in the namespace whose Secrets it reads. The job
// algebra they are composed from is the unit's (plugins/unit/server/relocation-jobs.ts).
import { tenantBucketName } from "./tenant-storage.ts";
import type { JobEnvVar } from "../../adapters/kube/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { TENANT_SECRET, TENANT_S3_SECRET } from "./tenant-secrets.ts";
import { type RelocationJob, MONGO_NAMESPACE, boxSpec, sharedMongoEnv, BOX_REMOTE, writeFile, listMongoDbs, MONGO_FLAGS, mongodumpLine, relocationJobName, hashLine } from "#unit/server/relocation-jobs.ts";

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
 *  (hostyour-engine-api-key, rendered by the kit for exactly the two members that read it), so it is
 *  dumped by its own job in an app member's namespace — see tenantDumpJobs.
 *
 *  Without it a hand recovery from the box restores a tenant whose jobs and engine no longer agree on
 *  a bearer, and the failure reads as an auth error rather than as a missing backup. */
export const TENANT_ENGINE_KEY = { env: "ENGINE_API_KEY", property: "engine-api-key", secret: "hostyour-engine-api-key", secretKey: "engine-api-key" } as const;

// The rclone remote `s3:` against a Garage endpoint, configured from $S3_* env the caller supplies.
export const S3_REMOTE = `export RCLONE_CONFIG_S3_TYPE=s3
export RCLONE_CONFIG_S3_PROVIDER=Other
export RCLONE_CONFIG_S3_ENDPOINT="$S3_ENDPOINT"
export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
`;

export interface TenantJobInputs {
  guid: string;
  /** The generation the jobs write or read, below the box root (generationFolder). */
  folder: string;
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
function tenantBucketNamespace(guid: string, apps: readonly string[], stage: Stage): string | null {
  const first = apps[0];
  return first === undefined ? null : memberNamespace(guid, first, stage);
}

/** The complete tenant dump — EVERYTHING the unit owns: the registration, every `<guid>_*` Mongo
 *  database, the bucket, and the crypto material as one file per Vault property. */
export function tenantDumpJobs(i: TenantJobInputs & { registrationYaml: string }): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      namespace: MONGO_NAMESPACE,
      sharedMongo: true,
      spec: {
        ...boxSpec("dump-mongo", i.guid, sharedMongoEnv),
        image: i.image,
        script:
          BOX_REMOTE +
          writeFile("/tmp/registration.yaml", i.registrationYaml) +
          hashLine("/tmp/registration.yaml", "registration.yaml") +
          `rclone copyto /tmp/registration.yaml "box:${i.folder}/registration.yaml"
${listMongoDbs(`${i.guid}_`, `_${i.stage}`)} > /tmp/dbs
cat /tmp/dbs
sed 's/^DB //' /tmp/dbs | while read -r db; do
  ${mongodumpLine("$db", "/tmp/$db.archive")}  ${hashLine("/tmp/$db.archive", "mongo/$db.archive")}  rclone copyto "/tmp/$db.archive" "box:${i.folder}/mongo/$db.archive"
  rm -f "/tmp/$db.archive"
done
`,
      },
    },
    {
      namespace: memberNamespace(i.guid, i.identityProvider, i.stage),
      spec: {
        ...boxSpec("dump-crypto", i.guid, TENANT_CRYPTO_KEYS.map((k) => ({ name: k.env, secretKeyRef: { name: TENANT_SECRET, key: k.env } }))),
        image: i.image,
        script:
          BOX_REMOTE +
          TENANT_CRYPTO_KEYS.map((k) => `printf '%s' "$${k.env}" > "/tmp/${k.property}"\n${hashLine(`/tmp/${k.property}`, `vault/${k.property}`)}rclone copyto "/tmp/${k.property}" "box:${i.folder}/vault/${k.property}"\n`).join(""),
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps, i.stage);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("dump-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script: BOX_REMOTE + S3_REMOTE + `rclone size "s3:${tenantBucketName(i.guid, i.stage)}" --json > /tmp/source-size
want=$(sed -n 's/.*"count":\\([0-9]*\\).*/\\1/p' /tmp/source-size)
[ -n "$want" ] || { echo "UNCOUNTED source bucket: rclone answered no count"; exit 1; }
rclone mkdir "box:${i.folder}/bucket"
rclone sync "s3:${tenantBucketName(i.guid, i.stage)}" "box:${i.folder}/bucket" --create-empty-src-dirs
rclone size "box:${i.folder}/bucket" --json > /tmp/copied-size
have=$(sed -n 's/.*"count":\\([0-9]*\\).*/\\1/p' /tmp/copied-size)
[ -n "$have" ] || { echo "UNCOUNTED copied bucket: rclone answered no count"; exit 1; }
echo "COUNT bucket source=$want copied=$have"
[ "$want" = "$have" ] || { echo "MISSING bucket objects: source has $want, copy has $have"; exit 1; }
printf '%s\\n' "$want" > /tmp/bucket-objects.txt
${hashLine("/tmp/bucket-objects.txt", "bucket-objects.txt")}rclone copyto /tmp/bucket-objects.txt "box:${i.folder}/bucket-objects.txt"
`,
      },
    });
    // The fifth crypto file, beside the other four under vault/. It runs HERE and not with them
    // because it is in a different Kubernetes Secret in a different namespace: the kit renders
    // hostyour-engine-api-key only where it is read, which is the engine and jobs members, and a dump
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
          hashLine(`/tmp/${TENANT_ENGINE_KEY.property}`, `vault/${TENANT_ENGINE_KEY.property}`) +
          `rclone copyto "/tmp/${TENANT_ENGINE_KEY.property}" "box:${i.folder}/vault/${TENANT_ENGINE_KEY.property}"\n`,
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
      sharedMongo: true,
      spec: {
        ...boxSpec("restore-mongo", i.guid, sharedMongoEnv),
        image: i.image,
        script:
          BOX_REMOTE +
          `rclone lsf "box:${i.folder}/mongo/" > /tmp/archives
while read -r f; do
  rclone copyto "box:${i.folder}/mongo/$f" "/tmp/$f"
  mongorestore ${MONGO_FLAGS} --archive="/tmp/$f" --drop --quiet
  rm -f "/tmp/$f"
done < /tmp/archives
`,
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps, i.stage);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("restore-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script: BOX_REMOTE + S3_REMOTE + `rclone sync "box:${i.folder}/bucket" "s3:${tenantBucketName(i.guid, i.stage)}" --create-empty-src-dirs\n`,
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
      sharedMongo: true,
      spec: {
        ...boxSpec("verify-mongo", i.guid, sharedMongoEnv),
        image: i.image,
        script:
          BOX_REMOTE +
          `${listMongoDbs(`${i.guid}_`, `_${i.stage}`)} | sed 's/^DB //' > /tmp/have
rclone lsf "box:${i.folder}/mongo/" > /tmp/archives
sed 's/\\.archive$//' /tmp/archives > /tmp/want
while read -r want; do
  grep -qx "$want" /tmp/have || { echo "MISSING database $want"; exit 1; }
done < /tmp/want
echo "COMPLETE mongo"
`,
      },
    },
  ];
  const bucketNs = tenantBucketNamespace(i.guid, i.apps, i.stage);
  if (bucketNs !== null) {
    jobs.push({
      namespace: bucketNs,
      spec: {
        ...boxSpec("verify-bucket", i.guid, tenantS3Env()),
        image: i.image,
        script:
          BOX_REMOTE +
          S3_REMOTE +
          // Each count lands in a file first: `sh -e` misses a failure inside a command substitution's
          // pipe, and two counts that could not be read would otherwise compare equal, both empty.
          `rclone size "box:${i.folder}/bucket" --json > /tmp/box-size
rclone size "s3:${tenantBucketName(i.guid, i.stage)}" --json > /tmp/target-size
want=$(sed -n 's/.*"count":\\([0-9]*\\).*/\\1/p' /tmp/box-size)
have=$(sed -n 's/.*"count":\\([0-9]*\\).*/\\1/p' /tmp/target-size)
[ -n "$want" ] && [ -n "$have" ] || { echo "UNCOUNTED bucket objects: rclone answered no count"; exit 1; }
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
    sharedMongo: true,
    spec: {
      name: relocationJobName("list-source", i.guid),
      image: i.image,
      env: [...sharedMongoEnv],
      script: listMongoDbs(`${i.guid}_`, `_${i.stage}`) + "\n",
    },
  };
}

/** Clear the SOURCE, last: drop the `<guid>_*` databases. The box is not touched: the generation the
 *  move took stays as the backup of the moment before it. */
export function tenantClearSourceJobs(i: { guid: string; stage: Stage; image: string }): RelocationJob[] {
  return [
    {
      namespace: MONGO_NAMESPACE,
      sharedMongo: true,
      spec: {
        name: relocationJobName("clear-source", i.guid),
        env: [...sharedMongoEnv],
        image: i.image,
        script: `${listMongoDbs(`${i.guid}_`, `_${i.stage}`)} | sed 's/^DB //' | while read -r db; do
  mongosh ${MONGO_FLAGS} --quiet --eval "db.getSiblingDB('$db').dropDatabase()"
  echo "DROPPED $db"
done
`,
      },
    },
  ];
}
