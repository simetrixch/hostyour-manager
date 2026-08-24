// The CONSUMER job builders of the relocation carrier — split from relocation-jobs.ts (which keeps
// the shared script building blocks + the tenant builders) along the 400-line budget. Same design:
// pure JobSpec composition, one job per Secret home, `DB`/`MISSING` lines as the wire format.
import type { ConsumerService } from "../../../shared/consumer.ts";
import type { JobEnvVar } from "../../adapters/kube/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import {
  boxSpec, BOX_REMOTE, MONGO_FLAGS, mongoEnv, writeFile, quoted, relocationJobName,
  MONGO_NAMESPACE, CONSUMER_POSTGRES,
  type RelocationJob,
} from "./relocation-jobs.ts";

/** The per-consumer PostgreSQL root password, off the instance's own Secret in the unit's namespace —
 *  the same one the dump and the restore dial with. */
const consumerPostgresEnv = (): JobEnvVar[] => [{ name: "POSTGRES_PASSWORD", secretKeyRef: { name: CONSUMER_POSTGRES.secret, key: CONSUMER_POSTGRES.key } }];


export interface ConsumerJobInputs {
  name: string;
  stage: Stage;
  /** The registration's literal databases[] — Mongo names under a mongodb claim, PostgreSQL names
   *  under a postgresql one (the registration's own engine-neutral contract). */
  databases: readonly string[];
  services: readonly ConsumerService[];
  /** The PVC names of the consumer namespace, listed off the cluster at step time. */
  pvcs: readonly string[];
  image: string;
}


/** The complete consumer dump: the registration, its Mongo databases[], the whole per-consumer
 *  PostgreSQL, the claim bucket, and every PVC as a tar — each job where its Secret lives. */
export function consumerDumpJobs(i: ConsumerJobInputs & { registrationYaml: string }): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      // The registration copy has no cluster-side Secret at all, so it rides the unit's own namespace.
      namespace: i.name,
      spec: {
        ...boxSpec("dump-reg", i.name),
        image: i.image,
        script: BOX_REMOTE + writeFile("/tmp/registration.yaml", i.registrationYaml) + `rclone copyto /tmp/registration.yaml "box:${i.name}/registration.yaml"\n`,
      },
    },
  ];
  if (i.services.includes("mongodb") && i.databases.length > 0) {
    jobs.push({
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("dump-mongo", i.name, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `for db in ${quoted(i.databases)}; do
  mongodump ${MONGO_FLAGS} --db "$db" --archive="/tmp/$db.archive" --quiet
  rclone copyto "/tmp/$db.archive" "box:${i.name}/mongo/$db.archive"
  rm -f "/tmp/$db.archive"
done
`,
      },
    });
  }
  if (i.services.includes("postgresql")) {
    jobs.push({
      namespace: i.name,
      spec: {
        ...boxSpec("dump-pg", i.name, consumerPostgresEnv()),
        image: i.image,
        // The WHOLE instance (roles included): the per-consumer PostgreSQL serves exactly this unit,
        // so pg_dumpall is the complete scope and stays complete when the unit adds a database.
        script:
          BOX_REMOTE +
          `PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -h ${CONSUMER_POSTGRES.host} -U ${CONSUMER_POSTGRES.user} -f /tmp/postgres-all.sql
rclone copyto /tmp/postgres-all.sql "box:${i.name}/postgres/all.sql"
`,
      },
    });
  }
  if (i.pvcs.length > 0) {
    jobs.push({
      namespace: i.name,
      spec: {
        ...boxSpec("dump-pvc", i.name),
        image: i.image,
        pvcMounts: i.pvcs.map((claim) => ({ claimName: claim, mountPath: `/pvc/${claim}`, readOnly: true })),
        script:
          BOX_REMOTE +
          i.pvcs.map((claim) => `tar czf "/tmp/${claim}.tar.gz" -C "/pvc/${claim}" .\nrclone copyto "/tmp/${claim}.tar.gz" "box:${i.name}/pvc/${claim}.tar.gz"\nrm -f "/tmp/${claim}.tar.gz"\n`).join(""),
      },
    });
  }
  return jobs;
}

/** What a complete consumer dump leaves on the box, given its claims. */
export function consumerExpectedDumpEntries(i: Pick<ConsumerJobInputs, "databases" | "services" | "pvcs">): string[] {
  return [
    "registration.yaml",
    ...(i.services.includes("mongodb") && i.databases.length > 0 ? ["mongo"] : []),
    ...(i.services.includes("postgresql") ? ["postgres"] : []),
    ...(i.pvcs.length > 0 ? ["pvc"] : []),
  ];
}

/** Restore the consumer's data into the TARGET — the mirror of consumerDumpJobs, minus the
 *  registration (the run re-commits that itself: git is the Manager's to write, not a job's). */
export function consumerRestoreJobs(i: ConsumerJobInputs): RelocationJob[] {
  const jobs: RelocationJob[] = [];
  if (i.services.includes("mongodb") && i.databases.length > 0) {
    jobs.push({
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("restore-mongo", i.name, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `rclone lsf "box:${i.name}/mongo/" | while read -r f; do
  rclone copyto "box:${i.name}/mongo/$f" "/tmp/$f"
  mongorestore ${MONGO_FLAGS} --archive="/tmp/$f" --drop --quiet
  rm -f "/tmp/$f"
done
`,
      },
    });
  }
  if (i.services.includes("postgresql")) {
    jobs.push({
      namespace: i.name,
      spec: {
        ...boxSpec("restore-pg", i.name, consumerPostgresEnv()),
        image: i.image,
        script:
          BOX_REMOTE +
          `rclone copyto "box:${i.name}/postgres/all.sql" /tmp/postgres-all.sql
PGPASSWORD="$POSTGRES_PASSWORD" psql -h ${CONSUMER_POSTGRES.host} -U ${CONSUMER_POSTGRES.user} -d postgres -f /tmp/postgres-all.sql
`,
      },
    });
  }
  if (i.pvcs.length > 0) {
    jobs.push({
      namespace: i.name,
      spec: {
        ...boxSpec("restore-pvc", i.name),
        image: i.image,
        pvcMounts: i.pvcs.map((claim) => ({ claimName: claim, mountPath: `/pvc/${claim}` })),
        script:
          BOX_REMOTE +
          i.pvcs.map((claim) => `rclone copyto "box:${i.name}/pvc/${claim}.tar.gz" "/tmp/${claim}.tar.gz"\ntar xzf "/tmp/${claim}.tar.gz" -C "/pvc/${claim}"\nrm -f "/tmp/${claim}.tar.gz"\n`).join(""),
      },
    });
  }
  return jobs;
}

/** Completeness on the TARGET for a consumer — every dumped Mongo archive has its database, and the
 *  bucket matches the box copy's object count. PostgreSQL and PVCs are proven by their restore jobs
 *  themselves (psql/tar fail non-zero on a broken restore). */
export function consumerVerifyCompletenessJobs(i: ConsumerJobInputs): RelocationJob[] {
  const jobs: RelocationJob[] = [];
  if (i.services.includes("mongodb") && i.databases.length > 0) {
    jobs.push({
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("verify-mongo", i.name, mongoEnv(i.stage)),
        image: i.image,
        script:
          BOX_REMOTE +
          `mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' > /tmp/have
rclone lsf "box:${i.name}/mongo/" | sed 's/\\.archive$//' | while read -r want; do
  grep -qx "$want" /tmp/have || { echo "MISSING database $want"; exit 1; }
done
echo "COMPLETE mongo"
`,
      },
    });
  }
  return jobs;
}

/** List the SOURCE's Mongo databases[] as `DB` lines — the consumer half of verify-source-released —
 *  or null when this consumer has nothing that step can measure.
 *
 *  ONLY the Mongo databases are listed, because they are the only consumer store the ServiceClaim
 *  cascade can destroy: the repoint prunes the unit's Application, the resources-finalizer takes its
 *  ServiceClaims with it, and the service-provisioner's mongodb teardown drops the claim's databases.
 *
 *  The per-consumer PostgreSQL is deliberately NOT listed. It is source 2 of that same Application
 *  (apps/postgresql in the consumers appset), so by the time this job would run its Deployment, its
 *  Service and its postgresql-credentials Secret are pruned — a pod dialling `postgres` could not even
 *  start. And there would be nothing to measure: deprovision_postgresql is a no-op and the data PVC
 *  carries Prune=false,Delete=false, so the cascade never touches that instance's data; only the
 *  namespace delete in clear-source does.
 *
 *  null means "this unit has no such database": an s3 / redis / registry-pull / forwardauth consumer,
 *  or a mongodb claim with an empty databases[] — both of which the registration permits. Returning an
 *  empty listing instead would read as "the source data was destroyed" for a unit that never had any. */
export function consumerSourceDbListJob(i: { name: string; stage: Stage; databases: readonly string[]; services: readonly ConsumerService[]; image: string }): RelocationJob | null {
  if (!i.services.includes("mongodb") || i.databases.length === 0) return null;
  return {
    namespace: MONGO_NAMESPACE,
    spec: {
      name: relocationJobName("list-source", i.name),
      image: i.image,
      env: mongoEnv(i.stage),
      script: `for db in ${quoted(i.databases)}; do
  mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' | grep -qx "$db" && echo "DB $db" || true
done
`,
    },
  };
}

/** Clear the consumer's SOURCE: drop its Mongo databases[] and delete the box folder. The
 *  per-consumer PostgreSQL and the PVCs fall with the source namespace, which the run deletes in the
 *  same step. */
export function consumerClearSourceJobs(i: { name: string; stage: Stage; databases: readonly string[]; services: readonly ConsumerService[]; image: string }): RelocationJob[] {
  const dropMongo =
    i.services.includes("mongodb") && i.databases.length > 0
      ? `for db in ${quoted(i.databases)}; do
  mongosh ${MONGO_FLAGS} --quiet --eval "db.getSiblingDB('$db').dropDatabase()"
  echo "DROPPED $db"
done
`
      : "";
  return [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        ...boxSpec("clear-source", i.name, mongoEnv(i.stage)),
        image: i.image,
        script: BOX_REMOTE + dropMongo + `rclone purge "box:${i.name}" || true\necho "FOLDER ${i.name} removed"\n`,
      },
    },
  ];
}

