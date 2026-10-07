import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema/runs.ts";
import { evtId as genEvtId } from "../kernel/ids.ts";
import { redact } from "../security/redact.ts";
import type { RunEventBus } from "./bus.ts";
import type { Logger } from "../kernel/logger.ts";
import type { RunStatus } from "../../shared/enums.ts";
import type { AnyRunDefinition } from "./types.ts";

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

/** Calls a definition's onTerminal hook (its status choreography) and never lets an error of it
 *  escalate: the run's terminal status is already committed, so a throwing hook could only corrupt the
 *  record of a run that has finished. Its failure lands in the run log as well as the process log,
 *  since the hook writes the inventory rows the run's outcome stands in. */
export function callOnTerminal(
  deps: { db: Db; bus: RunEventBus; logger: Logger },
  def: AnyRunDefinition | undefined,
  runId: string,
  params: Record<string, unknown>,
  status: RunStatus,
): void {
  if (!def?.onTerminal) return;
  try {
    def.onTerminal(status, { db: deps.db, runId, params });
  } catch (err) {
    deps.logger.error({ err, runId }, "onTerminal hook failed (swallowed)");
    try {
      appendRunMeta(deps.db, deps.bus, runId, `✗ post-run choreography (onTerminal → ${status}) failed: ${err instanceof Error ? err.message : String(err)} — server/cluster rows may not reflect this run's outcome`);
    } catch {
      // The process log line above stands; the run log could not take this one.
    }
  }
}
