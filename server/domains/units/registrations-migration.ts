// THE BOOT MIGRATION OF THE REGISTRATIONS: every registration file on both books branches, parsed
// through the schema this release ships and written back in the registry's own form where the bytes
// differ (registration-laws.ts migrateRegistrationFiles, called by each registry's migrateToSchema).
//
// WHY. A registration is written once by the run that creates the unit and rewritten only by a flip.
// When the schema gains a field with a default, every file written before carries no key for it, and
// a reader that reads the file BARE — the ApplicationSets read under missingkey=error — refuses the
// whole unit. The Manager's own reads fill the default in memory and nothing wrote it back, so an
// upgrade needed a hand: the standing tenant offboarded before the release and onboarded after it.
// This is the write-back. It runs once per boot, behind the listener and after the catalog carry
// (boot.ts), because a schema changes only with a release and a release boots the Manager; a timer
// would measure the same files against the same schema.
import type { Logger } from "../../kernel/logger.ts";
import { bootMarker, type RegistrationMigration } from "#unit/server/registration-laws.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";

/** Which books a migration ran over: the platform's (hostyour-cloud, the consumer registrations) or
 *  the catalog's (the tenant registrations). */
export type BooksName = "platform" | "catalog";

export type MigratedBooks =
  | ({ books: BooksName; branch: string } & RegistrationMigration)
  | { books: BooksName; branch: string; failed: string };

type Registry = Pick<Registrations, "branch" | "migrateToSchema"> | Pick<TenantRegistrations, "branch" | "migrateToSchema">;

export interface MigrateRegistrationsDeps {
  registrations?: Pick<Registrations, "branch" | "migrateToSchema"> | undefined;
  tenantRegistrations?: Pick<TenantRegistrations, "branch" | "migrateToSchema"> | undefined;
  /** The running Manager's version — the boot marker every commit ends with. */
  version: string;
  logger: Logger;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Both registries migrated, one after the other, and everything said in the log: every rewritten
 *  file with its fields and the commit, every refused file with its reason, and a branch that could
 *  not be read — the platform books that do not exist yet, a remote that is down — as one failure
 *  for that books. NEVER rejects: boot starts it unawaited. Answers what it did, so the self-check
 *  row can be declared from it (boot/selfchecks.ts checkRegistrationsMigrated). */
export async function migrateRegistrations(deps: MigrateRegistrationsDeps): Promise<MigratedBooks[]> {
  const marker = bootMarker(deps.version);
  const registries: { books: BooksName; registry: Registry | undefined }[] = [
    { books: "platform", registry: deps.registrations },
    { books: "catalog", registry: deps.tenantRegistrations },
  ];
  const outcomes: MigratedBooks[] = [];
  for (const { books, registry } of registries) {
    if (!registry) {
      deps.logger.info({ books }, "these books are not configured on this manager — no registration to migrate there");
      continue;
    }
    const branch = registry.branch;
    try {
      const outcome = await registry.migrateToSchema(marker);
      for (const r of outcome.refused) {
        deps.logger.warn({ books, branch, path: r.path, reason: r.reason }, "this registration is refused by the schema and was left as it stands — every reader refuses it the same way, so the unit it names is not served until a person settles the file");
      }
      deps.logger.info(
        { books, branch, read: outcome.read, rewritten: outcome.rewritten, refused: outcome.refused.length, commit: outcome.commit },
        outcome.commit ? "registrations migrated to the schema" : "every readable registration already stands in the schema's form",
      );
      outcomes.push({ books, branch, ...outcome });
    } catch (e) {
      const failed = messageOf(e);
      deps.logger.error({ books, branch, err: failed }, "the registrations could not be migrated to the schema — a registration written before a field gained its default keeps missing it, and a reader that reads the file bare refuses that unit until a boot succeeds");
      outcomes.push({ books, branch, failed });
    }
  }
  return outcomes;
}
