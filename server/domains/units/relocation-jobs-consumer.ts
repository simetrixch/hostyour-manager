// The CONSUMER job builders of the relocation carrier, composed from the unit's job algebra
// (plugins/unit/server/relocation-jobs.ts). Same design: pure JobSpec composition, one job per Secret
// home, `DB`/`MISSING` lines as the wire format.
import type { ConsumerService } from "../../../shared/consumer.ts";
import { isOrdinalClaim, type JobEnvVar, type JobIdentity, type ClaimUser } from "../../adapters/kube/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { MongodbMode } from "#unit/shared/unit-size.ts";
import {
  boxSpec, BOX_REMOTE, MONGO_FLAGS, mongodumpLine, mongoEnv, mongoHost, writeFile, quoted, relocationJobName, hashLine,
  MONGO_NAMESPACE,
  type RelocationJob,
} from "#unit/server/relocation-jobs.ts";

/** The per-consumer PostgreSQL instance coordinates (service-provisioner naming:
 *  `<claim>-<service>` with the claim named after the unit), and `claim`, the PVC its data directory
 *  lives on (hostyour-cloud clusters/units/postgresql, `postgres-data.pvc.name`). */
export const CONSUMER_POSTGRES = { host: "postgres", secret: "postgresql-credentials", key: "postgres-password", user: "postgres", claim: "postgres-data" } as const;

/** The claim template of a consumer's OWN MongoDB (hostyour-cloud clusters/units/mongodb, the
 *  StatefulSet `mongodb`'s template `data`): `data-mongodb-<n>`, one per member. */
const OWN_MONGO_CLAIM = "data-mongodb";

/** The claims a consumer's dump tars and its restore extracts: every PVC of the namespace but the
 *  data directories of its own stores, the per-consumer PostgreSQL's, whose databases dump-pg takes
 *  whole with pg_dumpall, and an own MongoDB's, whose databases dump-mongo takes with mongodump. A tar
 *  of a live data directory is no consistent copy, and extracting it would overwrite what the
 *  restore of that store loads. */
export function tarredClaims(i: Pick<ConsumerJobInputs, "pvcs" | "services" | "mongodb">): string[] {
  return i.pvcs.filter((claim) => !(i.services.includes("postgresql") && claim === CONSUMER_POSTGRES.claim) && !(i.mongodb !== "shared" && isOrdinalClaim(OWN_MONGO_CLAIM, claim)));
}

/** Where a consumer's MongoDB answers, so where its Mongo jobs run and what they dial: the shared set
 *  of the stage from the platform namespace, or the consumer's own instance from its own namespace,
 *  whose root password stands there in a Secret of the same name and key. */
/** Whether the generation holds a Mongo dump: always for an own instance, which is taken whole as
 *  the per-consumer PostgreSQL is, whatever databases[] and services name; on the shared set only the
 *  registration's databases[], which are all of the set that is the consumer's. */
const dumpsMongo = (i: Pick<ConsumerJobInputs, "services" | "databases" | "mongodb">): boolean =>
  i.mongodb !== "shared" || (i.services.includes("mongodb") && i.databases.length > 0);

/** Every database of an own instance but MongoDB's own three, as the list the dump walks; `grep -v`
 *  exits 1 on an instance that holds none yet, which is no failure. */
const OWN_DATABASES = `mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' > /tmp/listed
grep -vx -e admin -e local -e config /tmp/listed > /tmp/databases.txt || [ "$?" -eq 1 ]
`;

/** The generation's Mongo archives into /tmp/archives. For an own instance the list file beside them
 *  is left out, and a generation written before the instance was dumped whole holds no mongo folder
 *  at all, which lists as none. */
const mongoArchives = (i: Pick<ConsumerJobInputs, "mongodb" | "folder">): string =>
  i.mongodb === "shared"
    ? `rclone lsf "box:${i.folder}/mongo/" > /tmp/archives\n`
    : `rclone lsf "box:${i.folder}/" > /tmp/entries
: > /tmp/archives
if grep -qx 'mongo/' /tmp/entries; then rclone lsf --include '*.archive' "box:${i.folder}/mongo/" > /tmp/archives; fi
`;

/** An own instance's generation names every database it held in mongo/databases.txt; each needs its
 *  archive, or a dump that lost one would verify as complete. A generation without the list (written
 *  before the instance was dumped whole) has nothing to hold the archives against. */
const ownListCheck = (folder: string): string => `if grep -qx 'mongo/' /tmp/entries; then
  rclone lsf "box:${folder}/mongo/" > /tmp/mongo-entries
  if grep -qx 'databases.txt' /tmp/mongo-entries; then
    rclone copyto "box:${folder}/mongo/databases.txt" /tmp/listed.txt
    while read -r db; do
      grep -Fqx "$db.archive" /tmp/archives || { echo "MISSING archive $db"; exit 1; }
    done < /tmp/listed.txt
  fi
fi
`;

function consumerMongo(i: Pick<ConsumerJobInputs, "namespace" | "stage" | "mongodb">): { namespace: string; env: JobEnvVar[] } {
  if (i.mongodb === "shared") return { namespace: MONGO_NAMESPACE, env: mongoEnv(mongoHost(i.stage)) };
  return { namespace: i.namespace, env: mongoEnv(i.mongodb === "standalone" ? "mongodb" : `rs0/mongodb-headless.${i.namespace}.svc.cluster.local:27017`) };
}

/** The shell line that extracts one claim's archive into its mounted root. `--no-overwrite-dir` leaves
 *  the root as the volume made it: as the workload's user, tar may not set the mode or the time of a
 *  root-owned directory and would fail on it ("Cannot utime", exit 2). `--preserve-permissions` keeps
 *  the archive's modes: a user that is not root otherwise has them cut by the umask, so a directory
 *  the workload's group writes comes back without group write and without setgid. */
export function extractClaimLine(archive: string, root: string): string {
  return `tar xzf "${archive}" -C "${root}" --no-overwrite-dir --preserve-permissions`;
}

/** The job that lists the claims a generation holds: one `CLAIM <name>` line per `pvc/<name>.tar.gz`,
 *  none where the generation has no pvc/ folder, then `CLAIMS <count>`. Each listing lands in a file
 *  before it is read, because `sh -e` misses a failure inside a pipe, and a box that cannot be read
 *  must fail the job rather than read as a generation without claims. */
export function consumerGenerationClaimsJob(i: Pick<ConsumerJobInputs, "name" | "namespace" | "folder" | "image">): RelocationJob {
  return {
    namespace: i.namespace,
    spec: {
      ...boxSpec("list-pvc", i.name),
      image: i.image,
      script:
        BOX_REMOTE +
        `rclone lsf "box:${i.folder}/" > /tmp/generation
: > /tmp/claims
if grep -qx "pvc/" /tmp/generation; then
  rclone lsf "box:${i.folder}/pvc/" > /tmp/pvc
  sed -n 's/^\\(.*\\)\\.tar\\.gz$/\\1/p' /tmp/pvc > /tmp/claims
fi
n=0
while read -r claim; do echo "CLAIM $claim"; n=$((n + 1)); done < /tmp/claims
echo "CLAIMS $n"
`,
    },
  };
}

/** The claim names a consumerGenerationClaimsJob printed. Its closing count is what tells a generation
 *  without claims from a log that never arrived: a succeeded Job whose pod is gone answers no log at
 *  all, and that must stop the restore, not read as nothing to put back. */
export function parseClaimLines(logs: string): string[] {
  const lines = logs.split("\n").map((l) => l.trim());
  const claims = lines.filter((l) => l.startsWith("CLAIM ")).map((l) => l.slice("CLAIM ".length));
  const count = lines.find((l) => l.startsWith("CLAIMS "))?.slice("CLAIMS ".length);
  if (count === undefined || Number(count) !== claims.length) {
    throw errValidation(`the listing of the generation's claims came back ${count === undefined ? "without its closing count" : `with ${claims.length} claim(s) under a count of ${count}`}, so nothing says which claims it holds, and the restore stops before any store is written`);
  }
  return claims;
}

/** The per-consumer PostgreSQL root password, off the instance's own Secret in the unit's namespace —
 *  the same one the dump and the restore dial with. */
const consumerPostgresEnv = (): JobEnvVar[] => [{ name: "POSTGRES_PASSWORD", secretKeyRef: { name: CONSUMER_POSTGRES.secret, key: CONSUMER_POSTGRES.key } }];


export interface ConsumerJobInputs {
  /** The unit — the job names. */
  name: string;
  /** The generation the jobs write or read, below the box root (generationFolder). */
  folder: string;
  /** The unit's namespace on the cluster, `<name>-<stage>` — where its Secrets and PVCs stand, so
   *  where every job that reads them runs. */
  namespace: string;
  stage: Stage;
  /** The registration's literal databases[] — Mongo names under a mongodb claim, PostgreSQL names
   *  under a postgresql one (the registration's own engine-neutral contract). */
  databases: readonly string[];
  services: readonly ConsumerService[];
  /** Whose MongoDB the consumer uses: the stage's shared set, of which databases[] are its part, or its
   *  own instance, which is taken whole. */
  mongodb: MongodbMode;
  /** The PVC names of the consumer namespace, listed off the cluster at step time. */
  pvcs: readonly string[];
  /** Who the PVC dump and the PVC restore run as: the user the claims' files belong to on the cluster
   *  the job runs on, read off the workloads that mount them (claimsIdentity). */
  pvcUser?: JobIdentity;
  image: string;
}


/** The one identity that can read every claim in `claims`: the user and group of the workload
 *  containers that mount them. A claim no workload mounts, or claims used as different identities,
 *  are refused by name, because a job reading the files as any other user fails on the first one its
 *  owner alone may read. */
export function claimsIdentity(namespace: string, claims: readonly string[], users: readonly ClaimUser[]): JobIdentity {
  const identities = new Map<string, JobIdentity>();
  for (const claim of claims) {
    const mounted = users.filter((u) => u.claim === claim || (u.ordinals && isOrdinalClaim(u.claim, claim)));
    if (mounted.length === 0) {
      throw errValidation(`claim ${claim} in ${namespace} is mounted by no workload that states its user, so nothing says whose files it holds and a job reading or writing them would act as the wrong user`);
    }
    for (const u of mounted) identities.set(`${u.user}:${u.group}`, { user: u.user, group: u.group });
  }
  if (identities.size !== 1) {
    throw errValidation(`the claims in ${namespace} are used as ${[...identities.keys()].join(" and ")}, and one job reads and writes as one user`);
  }
  return [...identities.values()][0]!;
}

/** The complete consumer dump: the registration, its Mongo databases[] or its whole own MongoDB, the whole per-consumer
 *  PostgreSQL, the claim bucket, and every PVC as a tar — each job where its Secret lives. */
export function consumerDumpJobs(i: ConsumerJobInputs & { registrationYaml: string }): RelocationJob[] {
  const jobs: RelocationJob[] = [
    {
      // The registration copy has no cluster-side Secret at all, so it rides the unit's own namespace.
      namespace: i.namespace,
      spec: {
        ...boxSpec("dump-reg", i.name),
        image: i.image,
        script: BOX_REMOTE + writeFile("/tmp/registration.yaml", i.registrationYaml) + hashLine("/tmp/registration.yaml", "registration.yaml") + `rclone copyto /tmp/registration.yaml "box:${i.folder}/registration.yaml"\n`,
      },
    },
  ];
  if (dumpsMongo(i)) {
    const mongo = consumerMongo(i);
    jobs.push({
      namespace: mongo.namespace,
      spec: {
        ...boxSpec("dump-mongo", i.name, mongo.env),
        image: i.image,
        script:
          BOX_REMOTE +
          (i.mongodb === "shared"
            ? `for db in ${quoted(i.databases)}; do
  ${mongodumpLine("$db", "/tmp/$db.archive")}  ${hashLine("/tmp/$db.archive", "mongo/$db.archive")}  rclone copyto "/tmp/$db.archive" "box:${i.folder}/mongo/$db.archive"
  rm -f "/tmp/$db.archive"
done
`
            : OWN_DATABASES +
              `${hashLine("/tmp/databases.txt", "mongo/databases.txt")}rclone copyto /tmp/databases.txt "box:${i.folder}/mongo/databases.txt"
while read -r db; do
  ${mongodumpLine("$db", "/tmp/$db.archive")}  ${hashLine("/tmp/$db.archive", "mongo/$db.archive")}  rclone copyto "/tmp/$db.archive" "box:${i.folder}/mongo/$db.archive"
  rm -f "/tmp/$db.archive"
done < /tmp/databases.txt
`),
      },
    });
  }
  if (i.services.includes("postgresql")) {
    jobs.push({
      namespace: i.namespace,
      spec: {
        ...boxSpec("dump-pg", i.name, consumerPostgresEnv()),
        image: i.image,
        // The WHOLE instance (roles included): the per-consumer PostgreSQL serves exactly this unit,
        // so pg_dumpall is the complete scope and stays complete when the unit adds a database.
        script:
          BOX_REMOTE +
          `PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -h ${CONSUMER_POSTGRES.host} -U ${CONSUMER_POSTGRES.user} -f /tmp/postgres-all.sql
${hashLine("/tmp/postgres-all.sql", "postgres/all.sql")}rclone copyto /tmp/postgres-all.sql "box:${i.folder}/postgres/all.sql"
`,
      },
    });
  }
  const claims = tarredClaims(i);
  if (claims.length > 0) {
    jobs.push({
      namespace: i.namespace,
      spec: {
        ...boxSpec("dump-pvc", i.name),
        image: i.image,
        ...(i.pvcUser !== undefined ? { runAs: i.pvcUser } : {}),
        pvcMounts: claims.map((claim) => ({ claimName: claim, mountPath: `/pvc/${claim}`, readOnly: true })),
        script:
          BOX_REMOTE +
          // tar exits 1 when a file changed while it read it, which a live claim does, and the
          // archive is written all the same; any other exit is a failure.
          claims.map((claim) => `tar czf "/tmp/${claim}.tar.gz" -C "/pvc/${claim}" . || { s=$?; [ "$s" -eq 1 ] || exit "$s"; echo "CHANGED pvc/${claim}: files changed while tar read them"; }\n${hashLine(`/tmp/${claim}.tar.gz`, `pvc/${claim}.tar.gz`)}rclone copyto "/tmp/${claim}.tar.gz" "box:${i.folder}/pvc/${claim}.tar.gz"\nrm -f "/tmp/${claim}.tar.gz"\n`).join(""),
      },
    });
  }
  return jobs;
}

/** What a complete consumer dump leaves on the box, given its claims. */
export function consumerExpectedDumpEntries(i: Pick<ConsumerJobInputs, "databases" | "services" | "pvcs" | "mongodb">): string[] {
  return [
    "registration.yaml",
    ...(dumpsMongo(i) ? ["mongo"] : []),
    ...(i.services.includes("postgresql") ? ["postgres"] : []),
    ...(tarredClaims(i).length > 0 ? ["pvc"] : []),
  ];
}

/** An own instance on the target is restored into once it answers as a writable primary, bounded.
 *  Under `replicaset` the set is initiated by an Argo CD PostSync hook, and the Application reading
 *  Synced and Healthy does not say that hook has finished; a set that never elects a primary fails
 *  the restore with that reason instead of a mongorestore error. */
const OWN_PRIMARY_WAIT = `n=0
until mongosh ${MONGO_FLAGS} --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' > /dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -lt 60 ] || { echo "NO PRIMARY: the consumer's own MongoDB answered no writable primary within 5 minutes"; exit 1; }
  sleep 5
done
`;

/** Restore the consumer's data into the TARGET — the mirror of consumerDumpJobs, minus the
 *  registration (the run re-commits that itself: git is the Manager's to write, not a job's). */
export function consumerRestoreJobs(i: ConsumerJobInputs): RelocationJob[] {
  const jobs: RelocationJob[] = [];
  if (dumpsMongo(i)) {
    const mongo = consumerMongo(i);
    jobs.push({
      namespace: mongo.namespace,
      spec: {
        ...boxSpec("restore-mongo", i.name, mongo.env),
        image: i.image,
        script:
          BOX_REMOTE +
          (i.mongodb === "shared" ? "" : OWN_PRIMARY_WAIT) +
          mongoArchives(i) +
          `while read -r f; do
  rclone copyto "box:${i.folder}/mongo/$f" "/tmp/$f"
  mongorestore ${MONGO_FLAGS} --archive="/tmp/$f" --drop --quiet
  rm -f "/tmp/$f"
done < /tmp/archives
`,
      },
    });
  }
  if (i.services.includes("postgresql")) {
    jobs.push({
      namespace: i.namespace,
      spec: {
        ...boxSpec("restore-pg", i.name, consumerPostgresEnv()),
        image: i.image,
        // psql exits 0 after a failed statement, so its errors are read: the replay of a whole
        // instance meets the roles and the database the fresh instance's chart already created
        // ("already exists", harmless: the content goes into them), and any other error fails the job.
        // ON_ERROR_STOP cannot replace this: every pg_dumpall, the generations already on the box
        // among them, re-creates the bootstrap role, which exists on every instance.
        script:
          BOX_REMOTE +
          `rclone copyto "box:${i.folder}/postgres/all.sql" /tmp/postgres-all.sql
PGPASSWORD="$POSTGRES_PASSWORD" psql -h ${CONSUMER_POSTGRES.host} -U ${CONSUMER_POSTGRES.user} -d postgres -f /tmp/postgres-all.sql 2> /tmp/psql.err || { s=$?; cat /tmp/psql.err >&2; exit "$s"; }
cat /tmp/psql.err >&2
if grep -E '(ERROR|FATAL|error):' /tmp/psql.err | grep -vE 'ERROR:  (role|database) "[^"]+" already exists$'; then echo "the restore failed on the errors above, beyond the roles and database the fresh instance already holds" >&2; exit 1; fi
`,
      },
    });
  }
  const claims = tarredClaims(i);
  if (claims.length > 0) {
    jobs.push({
      namespace: i.namespace,
      spec: {
        ...boxSpec("restore-pvc", i.name),
        image: i.image,
        ...(i.pvcUser !== undefined ? { runAs: i.pvcUser } : {}),
        pvcMounts: claims.map((claim) => ({ claimName: claim, mountPath: `/pvc/${claim}` })),
        script:
          BOX_REMOTE +
          claims.map((claim) => `rclone copyto "box:${i.folder}/pvc/${claim}.tar.gz" "/tmp/${claim}.tar.gz"\n${extractClaimLine(`/tmp/${claim}.tar.gz`, `/pvc/${claim}`)}\nrm -f "/tmp/${claim}.tar.gz"\n`).join(""),
      },
    });
  }
  return jobs;
}

/** Completeness on the TARGET for a consumer — every dumped Mongo archive has its database, and the
 *  bucket matches the box copy's object count. PostgreSQL and PVCs are proven by their restore jobs
 *  themselves (tar fails non-zero on a broken restore, and the PostgreSQL restore on any psql error
 *  but the roles and database a fresh instance already holds). */
export function consumerVerifyCompletenessJobs(i: Omit<ConsumerJobInputs, "pvcs">): RelocationJob[] {
  const jobs: RelocationJob[] = [];
  if (dumpsMongo(i)) {
    const mongo = consumerMongo(i);
    jobs.push({
      namespace: mongo.namespace,
      spec: {
        ...boxSpec("verify-mongo", i.name, mongo.env),
        image: i.image,
        script:
          BOX_REMOTE +
          `mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' > /tmp/have
${mongoArchives(i)}${i.mongodb === "shared" ? "" : ownListCheck(i.folder)}sed 's/\\.archive$//' /tmp/archives > /tmp/want
while read -r want; do
  grep -qx "$want" /tmp/have || { echo "MISSING database $want"; exit 1; }
done < /tmp/want
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
 *  A consumer's OWN MongoDB is not listed either, for the PostgreSQL's reason: it is a source of that
 *  same Application, pruned with it, and its data claims fall only with the namespace in clear-source.
 *
 *  null means "this unit has no such database": an s3 / redis / registry-pull / forwardauth consumer,
 *  or a mongodb claim with an empty databases[] — both of which the registration permits. Returning an
 *  empty listing instead would read as "the source data was destroyed" for a unit that never had any. */
export function consumerSourceDbListJob(i: { name: string; stage: Stage; databases: readonly string[]; services: readonly ConsumerService[]; mongodb: MongodbMode; image: string }): RelocationJob | null {
  if (!i.services.includes("mongodb") || i.databases.length === 0 || i.mongodb !== "shared") return null;
  return {
    namespace: MONGO_NAMESPACE,
    spec: {
      name: relocationJobName("list-source", i.name),
      image: i.image,
      env: mongoEnv(mongoHost(i.stage)),
      // The listing lands in a file first: `sh -e` misses a failure inside a pipe, and a Mongo that
      // cannot be listed must fail the job, not read as databases the release destroyed.
      script: `mongosh ${MONGO_FLAGS} --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(function(d){print(d.name)})' > /tmp/mongo-databases
for db in ${quoted(i.databases)}; do
  if grep -qx "$db" /tmp/mongo-databases; then echo "DB $db"; fi
done
`,
    },
  };
}

/** Clear the consumer's SOURCE: drop its Mongo databases[] on the shared set. The per-consumer
 *  PostgreSQL, an own MongoDB and the PVCs fall with the source namespace, which the run deletes in the
 *  same step. The box is not touched: the generation the move took stays as the backup of the moment
 *  before it. */
export function consumerClearSourceJobs(i: { name: string; stage: Stage; databases: readonly string[]; services: readonly ConsumerService[]; mongodb: MongodbMode; image: string }): RelocationJob[] {
  if (!i.services.includes("mongodb") || i.databases.length === 0 || i.mongodb !== "shared") return [];
  return [
    {
      namespace: MONGO_NAMESPACE,
      spec: {
        name: relocationJobName("clear-source", i.name),
        env: mongoEnv(mongoHost(i.stage)),
        image: i.image,
        script: `for db in ${quoted(i.databases)}; do
  mongosh ${MONGO_FLAGS} --quiet --eval "db.getSiblingDB('$db').dropDatabase()"
  echo "DROPPED $db"
done
`,
      },
    },
  ];
}

