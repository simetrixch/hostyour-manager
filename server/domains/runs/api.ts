import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../../db/client.ts";
import type { Config } from "../../kernel/config.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Executor } from "../../executor/executor.ts";
import type { RunEventBus } from "../../executor/bus.ts";
import { listRuns, getRun, readEvents } from "../../executor/read.ts";
import { isTerminalRun } from "../../executor/transitions.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { RunEventView } from "../../../shared/api-types.ts";
import { runUnitCard } from "../inventory/run-unit-card.ts";
import type { AppEnv } from "../../http/app-env.ts";

export interface RunApiDeps {
  executor: Executor;
  db: Db;
  bus: RunEventBus;
  config: Config;
  logger: Logger;
}

function secretsFrom(raw: unknown): Record<string, Buffer> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Empty string ⇒ drop it, so an empty operator value surfaces as a "missing required secret"
    // (executor.approve) rather than being seeded as an empty secret.
    if (typeof v === "string" && v.length > 0) out[k] = Buffer.from(v, "base64");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Kind-agnostic Runs API. Read paths hit read.ts; every mutation goes through
 * the Executor — the single write path. CSRF is enforced upstream by http/middleware/csrf.
 * The Executor's actor() resolves to the signed-in operator of the current request
 * (kernel/actor.ts, bound by the chokepoint middleware), so runs.started_by and the run
 * audit rows name the human, not op_system.
 */
/** How long a run's event stream may stay silent before it sends a comment line. A run's gates can
 *  write nothing for half a minute, and a proxy on the way may close a connection idle that long. */
export const RUN_STREAM_IDLE_MS = 15_000;

export function registerRunRoutes(app: Hono<AppEnv>, deps: RunApiDeps): void {
  const { executor, db, bus } = deps;

  app.get("/api/runs", (c) => c.json(listRuns(db)));

  app.get("/api/runs/:id", (c) => {
    const run = getRun(db, c.req.param("id"));
    if (!run) throw errNotFound(`run ${c.req.param("id")}`);
    return c.json(run);
  });

  // The card of the unit a run acts on, for the run page's way back to it on the run's stage.
  app.get("/api/runs/:id/unit-card", (c) => {
    const run = getRun(db, c.req.param("id"));
    if (!run) throw errNotFound(`run ${c.req.param("id")}`);
    return c.json(runUnitCard(db, run));
  });

  app.get("/api/runs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!getRun(db, id)) throw errNotFound(`run ${id}`);
    const cursor = c.req.header("last-event-id") ?? c.req.query("after");
    const after = cursor !== undefined && Number.isFinite(Number(cursor)) ? Number(cursor) : -1;

    return streamSSE(c, async (stream) => {
      const send = (e: RunEventView): Promise<void> => stream.writeSSE({ id: String(e.seq), event: e.stream, data: JSON.stringify(e) });
      // The close is announced, because a browser reports a hop's dropped connection exactly as it
      // reports this one, and only the dropped one is to be reopened (web/src/runLogFollow.ts).
      const end = (): Promise<void> => stream.writeSSE({ event: "end", data: "" });

      for (const e of readEvents(db, id, after)) await send(e);
      const start = getRun(db, id);
      // Terminal or soft-deleted → nothing more will come — replay the backlog and close.
      if (!start || isTerminalRun(start.status) || start.deletedAt !== null) return end();

      const queue: RunEventView[] = [];
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe(id, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      try {
        for (;;) {
          while (queue.length > 0) await send(queue.shift() as RunEventView);
          if (stream.aborted) break;
          const now = getRun(db, id);
          if (!now || isTerminalRun(now.status) || now.deletedAt !== null) {
            while (queue.length > 0) await send(queue.shift() as RunEventView);
            await end();
            break;
          }
          let idle: ReturnType<typeof setTimeout> | undefined;
          const woken = await new Promise<boolean>((resolve) => {
            wake = () => resolve(true);
            idle = setTimeout(() => resolve(false), RUN_STREAM_IDLE_MS);
          });
          clearTimeout(idle);
          wake = null;
          // A comment line, which EventSource ignores: a hop that closes a silent connection sees none.
          if (!woken && !stream.aborted) await stream.write(": idle\n\n");
        }
      } finally {
        unsub();
      }
    });
  });

  app.post("/api/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string; params?: Record<string, unknown> };
    if (typeof body.kind !== "string") throw errValidation("kind is required");
    const result = await executor.plan(body.kind, body.params ?? {});
    return c.json(result, 201);
  });

  app.post("/api/runs/:id/approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { secrets?: unknown };
    await executor.approve(c.req.param("id"), secretsFrom(body.secrets));
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:id/discard", async (c) => {
    await executor.discard(c.req.param("id"));
    return c.json({ ok: true }, 202);
  });

  // Status-gated SOFT delete (unlike discard, which parks the run at `cancelled` but keeps
  // it listed): only a planned, failed, or cancelled run may be deleted — the executor
  // refuses anything else (succeeded, in-flight) with 409 ILLEGAL_TRANSITION. The run vanishes from the list (deleted_at set) while
  // its row + full log stay in the DB for retroactive inspection; GET /api/runs/:id still
  // resolves it, marked deleted. 200, not 202: the deletion is complete on return.
  app.delete("/api/runs/:id", async (c) => {
    await executor.deleteRun(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    await executor.cancel(c.req.param("id"));
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:id/retry", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { stepName?: string; secrets?: unknown };
    await executor.retryFromStep(c.req.param("id"), body.stepName, secretsFrom(body.secrets));
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:id/skip", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { stepName?: string; reason?: string };
    if (typeof body.stepName !== "string" || typeof body.reason !== "string") throw errValidation("stepName and reason are required");
    await executor.skipStep(c.req.param("id"), body.stepName, body.reason);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:id/abort", async (c) => {
    // The same secret re-entry surface as retry: a terminal run's secrets were wiped with it, and
    // a cleanup that drives the machine's programs needs the elevation password again.
    const body = (await c.req.json().catch(() => ({}))) as { secrets?: unknown };
    await executor.abortWithCleanup(c.req.param("id"), secretsFrom(body.secrets));
    return c.json({ ok: true }, 202);
  });
}
