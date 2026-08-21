import type { OperatorSession } from "../domains/access/session.ts";

/**
 * Which carrier presented the sealed session on this request. ONE identity, two carriers: a
 * browser sends it as the session cookie, a caller on the master sends the same sealed value as
 * `Authorization: Bearer`. There is no second kind of session and no second authority — the
 * chokepoint verifies both through the same SessionCodec. The CSRF guard is the only thing that
 * reads this, and http/middleware/csrf.ts states at the line why it may.
 */
export type AuthCarrier = "cookie" | "bearer";

/**
 * The Hono environment: the chokepoint sets `operator` once a request is past the gate; every
 * protected handler reads it via c.get("operator"). Lives in the http layer (it IS a Hono
 * concern) so the route-registration functions in any domain can type their app off it without
 * coupling one domain to another (domains-no-crosstalk). http → domains/access is the normal
 * direction; domain → http here is the route-seam type only.
 */
export type AppEnv = { Variables: { operator: OperatorSession; authCarrier: AuthCarrier } };
