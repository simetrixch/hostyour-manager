import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { operators } from "./schema/operators.ts";

/** The name a person reads for an operator. `runs.owner` holds an operators.id under a foreign
 *  key, and the baseline seeds `op_system`, so every run's starter resolves. */
export function getOperatorDisplayName(db: Db, id: string): string {
  const row = db.select({ displayName: operators.displayName }).from(operators).where(eq(operators.id, id)).get();
  if (!row) throw new Error(`no operator ${id}`);
  return row.displayName;
}
