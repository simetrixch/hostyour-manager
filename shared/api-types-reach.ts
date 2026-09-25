// What a server card reads about reaching its machine (GET /api/servers/:id/reach).

/** Whether this manager reaches a machine now, at the SSH port of the host its row names. `reason`
 *  says why not, in words a person reads on the card. */
export type ServerReachView =
  | { host: string; port: number; reachable: true }
  | { host: string; port: number; reachable: false; reason: string };
