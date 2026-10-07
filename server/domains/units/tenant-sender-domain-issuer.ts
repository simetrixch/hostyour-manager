// A tenant stage sends from its own sender domain only once the product's mail service lets the stage's
// service issuer send from it. The product declares where that is bound (tenant spec
// `senderDomainIssuers`): a route of one of its units that the Manager calls as itself, with the key it
// keeps for that unit's stage (unit-call-key.ts). One issuer is added or removed per call and the others
// stay, so an undo takes back only what its own call changed.
import type { Stage } from "../../../shared/enums.ts";
import type { CredentialStore } from "../../security/store.ts";
import { errValidation } from "../../kernel/errors.ts";
import { registerSecret } from "../../security/redact.ts";
import type { UnitCall } from "#unit/server/adapters/unit-call/port.ts";
import { findUnitCallKey } from "#unit/server/unit-call-key.ts";
import { stageApex, tenantMemberUrl } from "#unit/shared/unit-host.ts";
import type { TenantCluster } from "./lifecycle.ts";

/** The product's route for a stage's issuers at a sender domain, and the unit that serves it. */
export interface SenderDomainIssuers {
  url: string;
  unit: string;
}

/** The tenant stage's service issuer: its identity provider's address on the tenant's zone, the issuer
 *  its service tokens carry and the one its DNS mark holds (tenantIssuerRecord). */
export function stageServiceIssuer(tc: TenantCluster, unitApex: string): string {
  return tenantMemberUrl(tc.routing, tc.identityProvider, tc.stage, tc.subdomain, unitApex, "");
}

const mintRepair = (route: SenderDomainIssuers, stage: Stage): string =>
  `mint the key its manifest declares as generate: manager-key with "Secrets…" on ${route.unit} (${stage})`;

/** Why the Manager cannot call the route at the stage, or null where it keeps the key for it. */
export async function refuseWithoutKey(store: Pick<CredentialStore, "list">, route: SenderDomainIssuers, stage: Stage): Promise<string | null> {
  if (await findUnitCallKey(store, route.unit, stage)) return null;
  return `the Manager keeps no key for ${route.unit} (${stage}), so it cannot bind the issuer there — ${mintRepair(route, stage)}`;
}

/** Adds the issuer at the domain, or removes it; answers whether this call changed the domain's list.
 *  A race inside the product (409) is asked once more; every other refusal throws, naming its repair. */
export async function changeStageIssuer(
  deps: { store: Pick<CredentialStore, "list" | "open">; unitCall: UnitCall },
  req: { route: SenderDomainIssuers; stage: Stage; unitApex: string; domain: string; issuer: string; change: "add" | "remove"; runId: string; signal?: AbortSignal },
): Promise<boolean> {
  const { route, stage } = req;
  const ref = await findUnitCallKey(deps.store, route.unit, stage);
  if (!ref) throw errValidation(`the Manager keeps no key for ${route.unit} (${stage}) — ${mintRepair(route, stage)}`);
  const key = (await deps.store.open(ref.id, { purpose: `tenant-set-sender-domain:${req.change}-issuer`, runId: req.runId })).toString("utf8");
  registerSecret(req.runId, Buffer.from(key, "utf8"));
  const url = route.url.replaceAll("{stageApex}", stageApex(req.unitApex, stage)).replaceAll("{domain}", encodeURIComponent(req.domain));
  const call = () =>
    deps.unitCall.call({ method: req.change === "add" ? "PUT" : "DELETE", url, key, body: { issuer: req.issuer }, ...(req.signal ? { signal: req.signal } : {}) });
  let answer = await call();
  if (answer.status === 409) answer = await call();
  const at = `${route.unit} (${stage}), ${url}`;
  if (answer.status === 200) {
    const field = req.change === "add" ? "added" : "removed";
    const changed = (answer.body as Record<string, unknown> | undefined)?.[field];
    if (typeof changed !== "boolean") throw errValidation(`${at} answered 200 without "${field}" — nothing says whether it ${req.change === "add" ? "bound" : "removed"} ${req.issuer}`);
    return changed;
  }
  if (answer.status === 401) {
    throw errValidation(`${at} refused the key the Manager keeps for it (401): it is not the key ${route.unit} holds — ${mintRepair(route, stage)} again, or wait until ${route.unit} has restarted after a mint`);
  }
  if (answer.status === 503) throw errValidation(`${at} holds no Manager key yet (503) — ${mintRepair(route, stage)}`);
  if (answer.status === 404) throw errValidation(`${at} does not know ${req.domain} as a sender domain (404) — register it in its mail service first`);
  throw errValidation(`${at} did not ${req.change === "add" ? "bind" : "remove"} ${req.issuer}: ${answer.detail}`);
}
