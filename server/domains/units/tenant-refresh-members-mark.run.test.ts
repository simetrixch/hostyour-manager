import { describe, it, expect } from "vitest";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { makeTenantRefreshMembersDef } from "./tenant-refresh-members.run.ts";
import { GUID, MANIFEST_YAML, planned, ports, seedTenant, staleMembers, stepCtx, db, useMemoryDb } from "./tenant-refresh-members.fixture.ts";

// tenant-refresh-members is the one run that carries a change of the product's manifest to a standing
// tenant, so a product that declares the label of the identity provider's DNS mark after its tenants
// were created gets their marks here. Split from tenant-refresh-members.run.test.ts along its line budget.

useMemoryDb();

const LABELLED = MANIFEST_YAML.replace("tenant:\n  members:", "tenant:\n  issuerRecordLabel: _digita-idp\n  members:");
/** The fixture tenant: acme at prod under example.com, routed by host, its identity provider `auth`. */
const MARK_NAME = "_digita-idp.auth.acme.example.com";

describe("tenant-refresh-members puts the identity provider's DNS mark in place", () => {
  it("publishes the standing tenant's mark where the product declares the label, and books it for the tenant", async () => {
    seedTenant();
    const dns = new FakeDnsProvider();
    const prt = { ...ports(staleMembers(), { manifest: LABELLED }), dns };
    const p = await planned(prt);
    expect(p.issuerRecordLabel).toBe("_digita-idp");
    const step = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "publish-issuer-record");
    expect(step).toBeDefined();
    await step!.run(stepCtx(p, [], []));
    expect(await dns.listRecordContents({ name: MARK_NAME, type: "TXT" })).toEqual(["https://auth.acme.example.com"]);
    expect(listDnsWrites(db.db).find((w) => w.name === MARK_NAME)?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
  });

  it("PLANTED INNOCENT: a product that declares no label gets no step and no mark", async () => {
    seedTenant();
    const prt = { ...ports(staleMembers()), dns: new FakeDnsProvider() };
    const p = await planned(prt);
    expect(p.issuerRecordLabel).toBeUndefined();
    expect(makeTenantRefreshMembersDef(prt).steps(p).some((s) => s.name === "publish-issuer-record")).toBe(false);
  });
});
