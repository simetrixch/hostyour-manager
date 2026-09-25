// The tenant's jobs of move/backup/restore: its registration, its `<guid>_*` Mongo databases, its
// bucket and its crypto material, each job placed in the namespace whose Secrets it reads. The job
// algebra they are composed from is the unit's (plugins/unit/server/relocation-jobs.ts).
import type { JobEnvVar } from "../../adapters/kube/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { TENANT_SECRET, TENANT_S3_SECRET } from "./tenant-secrets.ts";
import { type RelocationJob, MONGO_NAMESPACE, boxSpec, mongoEnv, BOX_REMOTE, writeFile, listMongoDbs, MONGO_FLAGS, relocationJobName } from "#unit/server/relocation-jobs.ts";

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
      namespace: memberNamespace(i.guid, i.identityProvider, i.stage),
      spec: {
        ...boxSpec("dump-crypto", i.guid, TENANT_CRYPTO_KEYS.map((k) => ({ name: k.env, secretKeyRef: { name: TENANT_SECRET, key: k.env } }))),
        image: i.image,
        script:
          BOX_REMOTE +
          TENANT_CRYPTO_KEYS.map((k) => `printf '%s' "$${k.env}" > "/tmp/${k.property}"\nrclone copyto "/tmp/${k.property}" "box:${i.guid}/vault/${k.property}"\n`).join(""),
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
        script: BOX_REMOTE + S3_REMOTE + `rclone sync "s3:${i.guid}" "box:${i.guid}/bucket" --create-empty-src-dirs\n`,
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
  const bucketNs = tenantBucketNamespace(i.guid, i.apps, i.stage);
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
