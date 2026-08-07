import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { servers } from "../db/schema/inventory.ts";
import type { SshSession } from "../adapters/ssh/port.ts";
import { errValidation, errNotFound } from "../kernel/errors.ts";

// Machine-id record/verify. `ctx.attest()` (context.ts) still rejects with "not implemented", so
// this function is what a step calls instead: a destructive deploy step needs to be sure the box
// behind the (LAN) IP is the SAME box we adopted, so a stranger VM that later grabs a recycled IP
// can't be deployed in its place.
//
// `servers.machine_id` (inventory.ts) is NULL right after adopt — adopt never populated it. So on
// the FIRST deploy we *record* /etc/machine-id (backfill); on every later run we *verify* it and
// hard-fail on a mismatch.
//
// Deliberately a pure function over its deps (db, a live SshSession, serverId, an AbortSignal,
// an optional meta-logger) — no StepCtx, no globals — so a step wires it with
// `attestMachineId({ db: ctx.db, session: await ctx.ssh(), serverId, signal: ctx.signal,
// log: (l) => ctx.log("meta", l) })` while a unit test drives it with a fake session + an
// in-memory db, exactly like adopt.test.ts / context.test.ts.

export interface AttestMachineDeps {
  db: Db;
  /** A live session to the target (the "way to exec"); we only read /etc/machine-id over it. */
  session: SshSession;
  serverId: string;
  /** REQUIRED by the session API (port.ts ExecOptions.signal) — no unabortable execs. */
  signal: AbortSignal;
  /** Optional meta-logger. A step passes `(l) => ctx.log("meta", l)`; tests pass a spy. */
  log?: (line: string) => void;
}

export type AttestOutcome =
  | { action: "recorded"; machineId: string }
  | { action: "verified"; machineId: string };

/** Read /etc/machine-id over the session and normalize it (systemd writes a 32-char lower-hex
 *  string on its own line). Throws a validation error if the read fails or comes back empty. */
export async function readMachineId(session: SshSession, signal: AbortSignal): Promise<string> {
  let out = "";
  const r = await session.exec("cat /etc/machine-id", {
    signal,
    onStdout: (line: string) => {
      out += line;
    },
  });
  const id = out.trim().toLowerCase();
  if (r.code !== 0 || id === "") {
    throw errValidation("could not read /etc/machine-id on the target");
  }
  return id;
}

/**
 * Record-or-verify the target's machine identity.
 *  - stored id is NULL  -> RECORD it (backfill the row + meta-log "recorded machine-id ...").
 *  - stored id == read   -> OK (meta-log "machine-id verified ...").
 *  - stored id != read   -> THROW errValidation("this is not the machine we adopted ...").
 * The row is never overwritten on a mismatch — that is the whole protection.
 */
export async function attestMachineId(deps: AttestMachineDeps): Promise<AttestOutcome> {
  const { db, session, serverId, signal, log } = deps;
  const row = db
    .select({ machineId: servers.machineId, name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
    .get();
  if (!row) throw errNotFound(`server ${serverId} not found`);

  const observed = await readMachineId(session, signal);

  if (row.machineId === null) {
    db.update(servers).set({ machineId: observed }).where(eq(servers.id, serverId)).run();
    log?.(`recorded machine-id ${observed} for ${row.name}`);
    return { action: "recorded", machineId: observed };
  }
  if (row.machineId === observed) {
    log?.(`machine-id verified (${observed})`);
    return { action: "verified", machineId: observed };
  }
  throw errValidation(`this is not the machine we adopted: expected ${row.machineId} got ${observed}`, {
    serverId,
    expected: row.machineId,
    got: observed,
  });
}
