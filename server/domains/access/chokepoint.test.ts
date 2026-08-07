import { describe, it, expect } from "vitest";
import { requireOperator } from "./chokepoint.ts";
import type { OperatorSession } from "./session.ts";

const member: OperatorSession = { sub: "op_1", email: "a@x", groups: ["admins"], jti: "j", via: "oidc", authAt: 1_700_000_000 };
const nonMember: OperatorSession = { sub: "op_2", email: "b@x", groups: ["users"], jti: "k", via: "oidc", authAt: 1_700_000_000 };

describe("chokepoint tri-state gate", () => {
  it("unauthenticated when there is no session", () => {
    expect(requireOperator(undefined, "admins").kind).toBe("unauthenticated");
  });

  it("forbidden when authenticated but not in the admins group", () => {
    const r = requireOperator(nonMember, "admins");
    expect(r.kind).toBe("forbidden");
    if (r.kind === "forbidden") expect(r.identity.email).toBe("b@x");
  });

  it("ok when in the admins group", () => {
    const r = requireOperator(member, "admins");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.operator.sub).toBe("op_1");
  });

  it("a valid-but-forbidden session is NEVER unauthenticated (the anti-redirect-loop invariant)", () => {
    expect(requireOperator(nonMember, "admins").kind).not.toBe("unauthenticated");
  });
});
