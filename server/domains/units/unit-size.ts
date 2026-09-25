import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { unitSizes } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import {
  UNIT_SIZE, SIZE_COMPONENT, UNIT_SIZE_SEED, composeQuota,
  type UnitQuota, type UnitSize, type SizeComponent, type UnitComposition,
} from "../../../shared/unit-size.ts";

// The size table's two operations: fill it on a fresh database, and work out the ONE quota a unit
// gets. What a size means, and where the seed figures come from, is stated once in shared/unit-size.ts.

/** The whole table as the composer wants it — component -> size -> figures. Read once per resolve, so
 *  every part of one quota comes from the same moment; reading them one at a time would let an edit
 *  land between two parts and produce a sum that never stood in the table. */
function readTable(db: Db): Record<SizeComponent, Record<UnitSize, UnitQuota>> {
  const rows = db.select().from(unitSizes).all();
  const table = {} as Record<SizeComponent, Record<UnitSize, UnitQuota>>;
  for (const c of SIZE_COMPONENT) {
    table[c] = {} as Record<UnitSize, UnitQuota>;
    for (const s of UNIT_SIZE) {
      const r = rows.find((x) => x.component === c && x.name === s);
      if (!r) throw errNotFound(`unit size "${s}" of component "${c}" — the size table holds no such row`);
      table[c][s] = {
        requestsCpu: r.requestsCpu, requestsMemory: r.requestsMemory,
        limitsCpu: r.limitsCpu, limitsMemory: r.limitsMemory,
        pods: r.pods, persistentVolumeClaims: r.persistentVolumeClaims,
      };
    }
  }
  return table;
}

/**
 * Insert the seed rows that are ABSENT, and touch nothing that is present. Runs at every boot, so a
 * database created before a component existed gains its rows without a migration; create-only, so an
 * installation that edited `medium` does not find it reset to the shipped figures on the next restart.
 *
 * That create-only rule is the whole of it, and it is the same discipline the Vault seeder follows
 * (`cas: 0`): a re-run must never silently move a value a running unit was sized against. The
 * alternative — upsert — would make every restart a quiet re-pricing of every customer.
 *
 * Returns what it created, so boot can name it rather than claim it seeded a table it found complete.
 */
export function seedUnitSizes(db: Db): string[] {
  const created: string[] = [];
  for (const component of SIZE_COMPONENT) {
    for (const name of UNIT_SIZE) {
      if (db.select().from(unitSizes).where(and(eq(unitSizes.component, component), eq(unitSizes.name, name))).get()) continue;
      db.insert(unitSizes).values({ component, name, ...UNIT_SIZE_SEED[component][name] }).run();
      created.push(`${component}/${name}`);
    }
  }
  return created;
}

/**
 * The ONE quota a unit gets, from the TABLE — never from the seed constant. The distinction is the
 * point of the table: an installation that raised `medium` must have every registration written after
 * that raise carry the new figures, and a resolver reading the constant would keep writing the old
 * ones while the UI showed the new.
 *
 * `brings` is what the unit actually has — its own PostgreSQL, its own MongoDB and with how many
 * members — because the quota is base + postgresql + mongodb x members. It is NOT a second size: the
 * databases run at the unit's own size.
 *
 * Throws when a row is missing. There is no fall back to `small`: a unit whose size cannot be resolved
 * has no ceiling anyone chose, and writing a registration with a guessed one is how a customer
 * silently gets a different product than they were sold.
 */
export function resolveUnitQuota(db: Db, size: UnitSize, brings: UnitComposition): UnitQuota {
  return composeQuota(readTable(db), size, brings).quota;
}

/** The same resolve, with the PARTS it was summed from — what a screen shows so the one number can be
 *  read back to where it came from. */
export function explainUnitQuota(db: Db, size: UnitSize, brings: UnitComposition): ReturnType<typeof composeQuota> {
  return composeQuota(readTable(db), size, brings);
}

/** The whole table, in the declared component and size order rather than the table's row order — the
 *  order a reader expects, which is the vocabulary's and not SQLite's. What the size route serves and
 *  what the edit screen fills itself from. */
export function listUnitSizes(db: Db): Array<{ component: SizeComponent; name: UnitSize } & UnitQuota> {
  const table = readTable(db);
  return SIZE_COMPONENT.flatMap((component) => UNIT_SIZE.map((name) => ({ component, name, ...table[component][name] })));
}
