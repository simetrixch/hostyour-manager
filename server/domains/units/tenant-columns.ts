// The one projection every tenant route answers with.
//
// Held in its own file rather than at the top of api.ts because four routes read it and a fifth
// one added tomorrow must find it rather than write its own — two projections of the same row are
// two answers to "what is a tenant", and the screens that read them then disagree.
import { clusters, tenants } from "../../db/schema/inventory.ts";

export const TENANT_COLUMNS = {
  id: tenants.id,
  guid: tenants.guid,
  subdomain: tenants.subdomain,
  clusterId: tenants.clusterId,
  domain: clusters.domain,
  stage: clusters.stage,
  // The member set and which of them is the IdP: every view that names a namespace, an AppProject or
  // the tenant's auth host derives it from these two, so they belong in the one projection.
  members: tenants.members,
  identityProvider: tenants.identityProvider,
  seedUsers: tenants.seedUsers,
  suspended: tenants.suspended,
  owner: tenants.owner,
  provenance: tenants.provenance,
  status: tenants.status,
  // What the last administrator check found. On the list projection and not only on the detail
  // view, because the point of the check is that somebody sees a tenant nobody can get into
  // WITHOUT having to open it first.
  adminState: tenants.adminState,
  adminCount: tenants.adminCount,
  adminCheckedAt: tenants.adminCheckedAt,
  lastRunId: tenants.lastRunId,
  createdAt: tenants.createdAt,
  updatedAt: tenants.updatedAt,
};
