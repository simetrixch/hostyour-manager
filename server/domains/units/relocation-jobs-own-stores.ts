// The relocation jobs of the stores a consumer runs of its own beside PostgreSQL and MongoDB: a Redis
// (hostyour-cloud clusters/units/redis) and a MariaDB (clusters/units/mariadb). Composed into the
// consumer's dump, restore and verify by relocation-jobs-consumer.ts.
import type { JobEnvVar } from "../../adapters/kube/port.ts";
import { boxSpec, BOX_REMOTE, hashLine, type RelocationJob } from "#unit/server/relocation-jobs.ts";
import type { ConsumerJobInputs } from "./relocation-jobs-consumer.ts";

/** What an own store's job needs: the unit, its namespace, the generation and the image. */
type OwnStoreInputs = Pick<ConsumerJobInputs, "name" | "namespace" | "folder" | "image">;

/** A consumer's OWN Redis (hostyour-cloud clusters/units/redis): its Service, the Secret its password
 *  stands in (materialized from secret/<stage>/consumer/<name>/redis), and the claim its append-only
 *  files live on. */
export const CONSUMER_REDIS = { host: "redis", secret: "redis-credentials", key: "redis-password", claim: "redis-data" } as const;

/** A consumer's OWN MariaDB (hostyour-cloud clusters/units/mariadb): its Service, the Secret its root
 *  password stands in (materialized from secret/<stage>/consumer/<name>/mariadb), and the claim its
 *  data directory lives on. */
export const CONSUMER_MARIADB = { host: "mariadb", secret: "mariadb-credentials", key: "root-password", claim: "mariadb-data" } as const;

/** The own Redis's password, as redis-cli reads it without a flag on its command line. */
const consumerRedisEnv = (): JobEnvVar[] => [{ name: "REDISCLI_AUTH", secretKeyRef: { name: CONSUMER_REDIS.secret, key: CONSUMER_REDIS.key } }];

/** The own MariaDB's root password, as the jobs hand it to the client in a file of their own. */
const consumerMariadbEnv = (): JobEnvVar[] => [{ name: "MARIADB_ROOT_PASSWORD", secretKeyRef: { name: CONSUMER_MARIADB.secret, key: CONSUMER_MARIADB.key } }];

/** The client options file every MariaDB job writes first: the password stands on no command line,
 *  where every process of the pod could read it. */
const MARIADB_CLIENT = `printf '[client]\\nuser=root\\npassword=%s\\nhost=${CONSUMER_MARIADB.host}\\n' "$MARIADB_ROOT_PASSWORD" > /tmp/my.cnf
`;
const mariadb = "mariadb --defaults-extra-file=/tmp/my.cnf";

/** The application databases of an own MariaDB: every database but the server's own four. The server
 *  serves this unit alone, so it is taken whole, as an own MongoDB is. Its users are not dumped: the
 *  service-provisioner writes the one a claim gets from the claim, and the server's own accounts
 *  (root, mariadb.sys) are the target's. `grep -v` exits 1 on a server that holds none yet. */
const MARIADB_DATABASES = `${mariadb} -N -e 'SHOW DATABASES' > /tmp/listed
grep -vx -e information_schema -e mysql -e performance_schema -e sys /tmp/listed > /tmp/databases.txt || [ "$?" -eq 1 ]
`;

/** Restore an own Redis by replication, never by a file on its claim: the server persists with AOF and
 *  loads only its AOF files at a start, so a dump placed beside them would leave it empty. The job
 *  starts a throwaway server from the snapshot, without persistence, makes the consumer's server its
 *  replica until the sync has ended and both stand at the same offset, and makes it a primary again
 *  whatever the outcome. Its AOF then holds what the replication wrote. The key counts are compared
 *  after the promotion, so a target that came up short fails the job. */
const REDIS_RESTORE = (folder: string): string => `mkdir -p /tmp/redis
rclone copyto "box:${folder}/redis/dump.rdb" /tmp/redis/dump.rdb
redis-server --dir /tmp/redis --dbfilename dump.rdb --appendonly no --save "" --bind 0.0.0.0 --protected-mode no --port 6379 --requirepass "$REDISCLI_AUTH" --daemonize yes
n=0
until [ "$(redis-cli -h 127.0.0.1 PING 2>/dev/null)" = PONG ] && redis-cli -h 127.0.0.1 INFO persistence | grep -q '^loading:0'; do
  n=$((n + 1))
  [ "$n" -lt 60 ] || { echo "NO SNAPSHOT: the throwaway server did not load the snapshot within 5 minutes"; exit 1; }
  sleep 5
done
want=$(redis-cli -h 127.0.0.1 DBSIZE)
promote() { redis-cli -h ${CONSUMER_REDIS.host} REPLICAOF NO ONE > /dev/null; redis-cli -h ${CONSUMER_REDIS.host} CONFIG SET masterauth "" > /dev/null; }
trap promote EXIT
redis-cli -h ${CONSUMER_REDIS.host} CONFIG SET masterauth "$REDISCLI_AUTH" > /dev/null
redis-cli -h ${CONSUMER_REDIS.host} REPLICAOF "$(hostname -i | cut -d' ' -f1)" 6379 > /dev/null
offset() { sed -n "s/^$1:\\([0-9]*\\).*/\\1/p" "$2"; }
n=0
while :; do
  redis-cli -h ${CONSUMER_REDIS.host} INFO replication > /tmp/redis/replica
  redis-cli -h 127.0.0.1 INFO replication > /tmp/redis/primary
  if grep -q '^master_link_status:up' /tmp/redis/replica && grep -q '^master_sync_in_progress:0' /tmp/redis/replica &&
    [ "$(offset slave_repl_offset /tmp/redis/replica)" = "$(offset master_repl_offset /tmp/redis/primary)" ]; then break; fi
  n=$((n + 1))
  [ "$n" -lt 120 ] || { echo "NO SYNC: the consumer's Redis did not finish replicating the snapshot within 10 minutes"; exit 1; }
  sleep 5
done
have=$(redis-cli -h ${CONSUMER_REDIS.host} DBSIZE)
promote
trap - EXIT
[ "$have" = "$want" ] || { echo "MISSING redis: the target holds $have keys of the snapshot's $want"; exit 1; }
echo "COMPLETE redis: $have keys"
`;

/** dump-redis: the own Redis's snapshot. */
export const ownRedisDumpJob = (i: OwnStoreInputs): RelocationJob => ({
  namespace: i.namespace,
  spec: {
    ...boxSpec("dump-redis", i.name, consumerRedisEnv()),
    image: i.image,
    // A snapshot the server writes for a replica: consistent, and taken without stopping it.
    script:
      BOX_REMOTE +
      `redis-cli -h ${CONSUMER_REDIS.host} --rdb /tmp/redis.rdb
${hashLine("/tmp/redis.rdb", "redis/dump.rdb")}rclone copyto /tmp/redis.rdb "box:${i.folder}/redis/dump.rdb"
`,
  },
});

/** restore-redis: the snapshot back by replication (REDIS_RESTORE). */
export const ownRedisRestoreJob = (i: OwnStoreInputs): RelocationJob => ({
  namespace: i.namespace,
  spec: { ...boxSpec("restore-redis", i.name, consumerRedisEnv()), image: i.image, script: BOX_REMOTE + REDIS_RESTORE(i.folder) },
});

/** dump-mariadb: the own MariaDB's application databases. */
export const ownMariadbDumpJob = (i: OwnStoreInputs): RelocationJob => ({
  namespace: i.namespace,
  spec: {
    ...boxSpec("dump-mariadb", i.name, consumerMariadbEnv()),
    image: i.image,
    // One consistent InnoDB snapshot of the application databases, with their routines,
    // triggers and events, taken while the server runs.
    script:
      BOX_REMOTE +
      MARIADB_CLIENT +
      MARIADB_DATABASES +
      `${hashLine("/tmp/databases.txt", "mariadb/databases.txt")}rclone copyto /tmp/databases.txt "box:${i.folder}/mariadb/databases.txt"
if [ -s /tmp/databases.txt ]; then
  mariadb-dump --defaults-extra-file=/tmp/my.cnf --single-transaction --routines --triggers --events --databases $(cat /tmp/databases.txt) > /tmp/mariadb.sql
else
  : > /tmp/mariadb.sql
fi
${hashLine("/tmp/mariadb.sql", "mariadb/all.sql")}rclone copyto /tmp/mariadb.sql "box:${i.folder}/mariadb/all.sql"
`,
  },
});

/** restore-mariadb: the dump replayed into the fresh server. */
export const ownMariadbRestoreJob = (i: OwnStoreInputs): RelocationJob => ({
  namespace: i.namespace,
  spec: {
    ...boxSpec("restore-mariadb", i.name, consumerMariadbEnv()),
    image: i.image,
    // The target's server is fresh; it answers once its first start has initialised it.
    script:
      BOX_REMOTE +
      MARIADB_CLIENT +
      `n=0
until ${mariadb} -e 'SELECT 1' > /dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -lt 60 ] || { echo "NO SERVER: the consumer's own MariaDB did not answer within 5 minutes"; exit 1; }
  sleep 5
done
rclone copyto "box:${i.folder}/mariadb/all.sql" /tmp/mariadb.sql
${mariadb} < /tmp/mariadb.sql
`,
  },
});

/** verify-mariadb: every dumped database stands on the target. */
export const ownMariadbVerifyJob = (i: OwnStoreInputs): RelocationJob => ({
  namespace: i.namespace,
  spec: {
    ...boxSpec("verify-mariadb", i.name, consumerMariadbEnv()),
    image: i.image,
    script:
      BOX_REMOTE +
      MARIADB_CLIENT +
      `${mariadb} -N -e 'SHOW DATABASES' > /tmp/have
rclone copyto "box:${i.folder}/mariadb/databases.txt" /tmp/want
while read -r want; do
  grep -qx "$want" /tmp/have || { echo "MISSING database $want"; exit 1; }
done < /tmp/want
echo "COMPLETE mariadb"
`,
  },
});
