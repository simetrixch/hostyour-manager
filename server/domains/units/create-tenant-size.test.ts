import { describe, it, expect } from "vitest";
import { CreateTenantRequest } from "./create-tenant.run.ts";

// A tenant has no default size: the operator names one, and T5 says when it is too small for the
// members. A preset would put every unattended create on a size its platform members may not fit.

describe("create-tenant's size", () => {
  it("refuses a request without a size, naming the field", () => {
    const issues = CreateTenantRequest.safeParse({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "o" }).error?.issues ?? [];
    expect(issues.map((i) => i.path.join("."))).toEqual(["size"]);
  });

  it("takes a size a tenant is offered", () => {
    expect(CreateTenantRequest.safeParse({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "o", size: "xsmall" }).success).toBe(true);
  });
});
