import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema/runs.ts";
import { evtId as genEvtId } from "../kernel/ids.ts";
import { redact } from "../security/redact.ts";
import type { RunEventBus } from "./bus.ts";

/** One meta line in a run's log, outside any step: stored after the run's last event, redacted, and
 *  published to whoever watches the run. */
export function appendRunMeta(db: Db, bus: RunEventBus, runId: string, text: string): void {
  const row = db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${events.seq}), -1)` })
    .from(events)
    .where(eq(events.runId, runId))
    .get();
  const seq = (row?.maxSeq ?? -1) + 1;
  const line = redact(text);
  db.insert(events).values({ id: genEvtId(), runId, stepId: null, stream: "meta", seq, text: line }).run();
  bus.publish(runId, { seq, stream: "meta", text: line, at: Date.now() });
}
