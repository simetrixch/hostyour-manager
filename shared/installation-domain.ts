import { z } from "zod";
import { publicFqdn } from "./consumer.ts";
import { DomainChangeSchema } from "./domain-move.ts";
import { STAGE, DNS_WRITE_ACT } from "./enums.ts";

const BookSchema = z.object({
  name: z.string(), type: z.enum(["CNAME", "TXT"]), content: z.string(),
  act: z.enum(DNS_WRITE_ACT),
  owner: z.object({ kind: z.string(), name: z.string(), stage: z.enum(STAGE).optional() }), runId: z.string(),
});
export const InstallationDomainSnapshotSchema = z.object({
  fromDomain: publicFqdn, toDomain: publicFqdn, booksBranch: z.string(),
  clusters: z.array(z.object({ id: z.string(), serverId: z.string(), name: z.string(), fromFqdn: publicFqdn, toFqdn: publicFqdn,
    mapPath: z.string(), apexBefore: publicFqdn, apexAfter: publicFqdn })),
  records: z.array(z.object({ name: z.string(), targetName: z.string(), type: z.enum(["CNAME", "TXT"]),
    before: z.string(), after: z.string(), owner: BookSchema.shape.owner, targetHadValue: z.boolean(),
    sourceBook: BookSchema.nullable(), targetBook: BookSchema.nullable() })),
  registrations: z.array(z.object({ kind: z.enum(["consumer", "tenant"]), name: z.string(), stage: z.enum(STAGE), changes: z.array(DomainChangeSchema) })),
  tenants: z.array(z.object({ id: z.string().nullable(), guid: z.string(), stage: z.enum(STAGE),
    issuerBefore: z.string(), issuerAfter: z.string(), cookieBefore: z.string(), cookieAfter: z.string(),
    cookieOverrides: z.array(z.object({ path: z.array(z.string()), before: z.string(), after: z.string() })),
    ownDomainBefore: z.string(), ownDomainAfter: z.string(), redirectsBefore: z.array(z.string()), redirectsAfter: z.array(z.string()),
    // What a move needs to rebind the stage's issuer at its own sender domain. A plan frozen before
    // they were recorded lacks them, and its run rebinds nothing.
    senderDomain: z.string().optional(), zoneBefore: z.string().optional(), zoneAfter: z.string().optional(),
    clusterId: z.string().optional(), members: z.array(z.string()).optional() })),
  retainedBooks: z.array(z.object({ name: z.string(), type: z.string(), reason: z.string() })),
  blockers: z.array(z.string()),
  coverage: z.object({ clusters: z.number(), consumers: z.number(), tenants: z.number(), stages: z.array(z.enum(STAGE)),
    persistedStores: z.string(), sessions: z.string(), cookieDomains: z.string() }),
});
export type InstallationDomainSnapshot = z.infer<typeof InstallationDomainSnapshotSchema>;
export const InstallationDomainParamsSchema = z.object({
  fromDomain: publicFqdn, toDomain: publicFqdn, dryRun: z.boolean().default(true),
  snapshot: InstallationDomainSnapshotSchema.optional(),
});
export type InstallationDomainParams = z.infer<typeof InstallationDomainParamsSchema>;

export const InstallationDomainRollbackParamsSchema = z.object({ sourceRunId: z.string().startsWith("run_"), dryRun: z.boolean().default(true), snapshot: InstallationDomainSnapshotSchema.optional() });
export type InstallationDomainRollbackParams = z.infer<typeof InstallationDomainRollbackParamsSchema>;
