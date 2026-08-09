import type { OperatorSession } from "../domains/access/session.ts";

/**
 * The Hono environment: the chokepoint sets `operator` once a request is past the gate; every
 * protected handler reads it via c.get("operator"). Lives in the http layer (it IS a Hono
 * concern) so the route-registration functions in any domain can type their app off it without
 * coupling one domain to another (domains-no-crosstalk). http → domains/access is the normal
 * direction; domain → http here is the route-seam type only.
 */
export type AppEnv = { Variables: { operator: OperatorSession } };
