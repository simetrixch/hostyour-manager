// Whether this manager can reach ONE machine now — the door every run of it opens first, its SSH
// port at the host its row names. The reading behind a server card's error: a machine that moved to
// another name answers nothing at the one its row holds, and the card offers the rename there.
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { servers } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import type { TcpProbe } from "../../adapters/net-probe/port.ts";
import type { ServerReachView } from "../../../shared/api-types-reach.ts";

/** How long the door is given. A run waits far longer for a session; a card is read by a person. */
export const REACH_TIMEOUT_MS = 5_000;

export async function readServerReach(deps: { db: Db; probe: TcpProbe }, serverId: string): Promise<ServerReachView> {
  const server = deps.db.select({ host: servers.host, sshPort: servers.sshPort }).from(servers).where(eq(servers.id, serverId)).get();
  if (!server) throw errNotFound(`server ${serverId}`);
  const answer = await deps.probe.reach({ host: server.host, port: server.sshPort, timeoutMs: REACH_TIMEOUT_MS });
  return answer.reachable
    ? { host: server.host, port: server.sshPort, reachable: true }
    : { host: server.host, port: server.sshPort, reachable: false, reason: answer.reason };
}
