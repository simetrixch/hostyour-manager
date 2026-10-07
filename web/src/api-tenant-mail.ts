// The mail actions of a tenant's page: the domain its mail is sent as and the name it is shown under
// there. Each only plans its run, which the Runs API approves.
import { post } from "./request.ts";

/** Plan tenant-set-sender-domain: send the tenant's mail as `domain` ("" as the platform's own). */
export const setTenantSenderDomain = (tenantId: string, domain: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/sender-domain`, { senderDomain: domain });

/** Plan tenant-set-display-name: show the tenant under `name` ("" for none). */
export const setTenantDisplayName = (tenantId: string, name: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/display-name`, { displayName: name });
