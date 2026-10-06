// What two consumer registrations on one cluster may not share: a database on the cluster's SHARED
// MongoDB, or keys or Pub/Sub channels on its SHARED Redis. Sharing one means one stage reads, and acts on, another's data:
// a PROD worker delivering the mail its TEST stage queued is what that looks like. The names compared
// are the ones the provisioner SERVES (hostyour-cloud service-provisioner `_served_databases`): the
// manifest's name at prod, `<name>_<stage>` at any other stage, and nothing of an own server, which no
// other namespace reaches.
import { STAGE, type Stage } from "../../../shared/enums.ts";
import type { ConsumerStageRegistration } from "../../../shared/consumer.ts";

/** The facts of a registration the guard reads: what it claims, and on which kind of server. */
export type SharedDataClaim = Pick<ConsumerStageRegistration, "services" | "databases" | "mongodb"> &
  Partial<Pick<ConsumerStageRegistration, "redis" | "keyPatterns" | "channelPatterns">>;

/** The databases a claim is served on the cluster's shared MongoDB at `stage`; none where it claims no
 *  mongodb or brings its own server. */
export function servedSharedDatabases(claim: SharedDataClaim, stage: Stage): string[] {
  if (!claim.services.includes("mongodb") || claim.mongodb !== "shared") return [];
  return stage === "prod" ? [...claim.databases] : claim.databases.map((d) => `${d}_${stage}`);
}

const onSharedRedis = (claim: SharedDataClaim): boolean => claim.services.includes("redis") && (claim.redis ?? "shared") === "shared";

/** The key patterns a claim is granted on the cluster's shared Redis; none for an own server. */
export function sharedKeyPatterns(claim: SharedDataClaim): string[] {
  return onSharedRedis(claim) ? [...(claim.keyPatterns ?? [])] : [];
}

/** The Pub/Sub channel patterns a claim is granted on the cluster's shared Redis; none for an own
 *  server. Two claims whose channels meet receive one another's messages. */
export function sharedChannelPatterns(claim: SharedDataClaim): string[] {
  return onSharedRedis(claim) ? [...(claim.channelPatterns ?? [])] : [];
}

const REDIS_SPACES = [
  { word: "keys", granted: sharedKeyPatterns, harm: "read and write one another's keys" },
  { word: "channels", granted: sharedChannelPatterns, harm: "receive one another's messages" },
] as const;

/** The literal part of a key pattern, up to its first glob character. */
const literalPrefix = (pattern: string): string => pattern.split(/[*?[]/)[0] ?? "";

/** Whether two key patterns can match one key. Compared by their literal prefixes, which errs on the
 *  side of refusing: `a:x*` and `a:*y` are taken to meet, and so are the exact key `shop` and
 *  `shopping:*`, because a pattern without a glob is compared as a prefix too. */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** The registrations of one cluster at one stage, as the books branch lists them, with the files the
 *  listing could not read. */
export interface ClusterRegistrations {
  listConsumerRegistrations(cluster: string, stage: Stage): Promise<{ registrations: { name: string; entry: ConsumerStageRegistration }[]; skipped: { reason: string }[] }>;
}

/** Why `name` may not be registered at `stage` on `cluster`, or null: another registration on the same
 *  cluster is served a database it would be served, or holds keys or channels its patterns would
 *  reach, or a registration file could not be read, because an unread file may be the one it meets.
 *  The registration being replaced (the same name at the same stage) is not compared with itself. */
export async function sharedDataRefusal(
  registrations: ClusterRegistrations,
  cluster: string,
  stage: Stage,
  name: string,
  claim: SharedDataClaim,
): Promise<string | null> {
  const databases = servedSharedDatabases(claim, stage);
  if (databases.length === 0 && REDIS_SPACES.every((s) => s.granted(claim).length === 0)) return null;
  for (const other of STAGE) {
    const { registrations: standing, skipped } = await registrations.listConsumerRegistrations(cluster, other);
    if (skipped.length > 0) {
      return `${name} at ${stage} cannot be checked against the data of the registrations on ${cluster}: ${skipped[0]!.reason} — repair that file, because an unread registration may be the one ${name} would share data with`;
    }
    for (const r of standing) {
      if (r.name === name && other === stage) continue;
      const shared = servedSharedDatabases(r.entry, other).find((d) => databases.includes(d));
      if (shared) {
        return `${name} at ${stage} would be served the database ${shared} on ${cluster}'s shared MongoDB, which ${r.name} at ${other} is served already — the two would read and write one another's data`;
      }
      for (const space of REDIS_SPACES) {
        const patterns = space.granted(claim);
        for (const p of space.granted(r.entry)) {
          const meets = patterns.find((q) => patternsOverlap(p, q));
          if (meets) {
            return `${name} at ${stage} would be granted the Redis ${space.word} ${meets} on ${cluster}'s shared Redis, which meet the ${space.word} ${p} of ${r.name} at ${other} — the two would ${space.harm}`;
          }
        }
      }
    }
  }
  return null;
}
