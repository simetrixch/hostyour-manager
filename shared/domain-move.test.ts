import { describe, expect, it } from "vitest";
import { applyDomainChanges, domainChanges, moveDomain, movePublicAddress } from "./domain-move.ts";

const FROM = "old.example", TO = "new.example";
describe("public domain journal", () => {
  it("maps DNS boundaries, wildcards, cookie dots and public URL hosts only", () => {
    expect(moveDomain("*.shop.old.example", FROM, TO)).toBe("*.shop.new.example");
    expect(moveDomain("notold.example", FROM, TO)).toBe("notold.example");
    expect(movePublicAddress("https://auth.old.example:8443/auth", FROM, TO)).toBe("https://auth.new.example:8443/auth");
    expect(movePublicAddress(".shop.old.example", FROM, TO)).toBe(".shop.new.example");
    expect(movePublicAddress("mongodb://db.old.example/private", FROM, TO)).toBe("mongodb://db.old.example/private");
  });
  it("refuses credentials and signed public URLs before they enter the journal", () => {
    for (const url of ["https://user:password@auth.old.example", "https://auth.old.example?token=private", "https://auth.old.example#private"]) expect(() => movePublicAddress(url, FROM, TO)).toThrow();
  });
  it("journals host fields and named environment values, preserving data and reset fields", () => {
    const entry = { members: [{ name: "auth", sources: [{ chart: "charts/auth", values: { cookieDomain: ".shop.old.example", env: [{ name: "AUTH_URL", value: "https://auth.old.example" }], password: "old.example", resetNonce: "old.example" } }] }] };
    const changes = domainChanges(entry, FROM, TO, ["members"]);
    expect(changes).toHaveLength(2);
    const moved = applyDomainChanges(entry, changes);
    expect(moved.members[0]!.sources[0]!.values.password).toBe("old.example");
    expect(moved.members[0]!.sources[0]!.values.resetNonce).toBe("old.example");
    expect(applyDomainChanges(moved, changes)).toEqual(moved);
    expect(applyDomainChanges(moved, changes, true)).toEqual(entry);
    expect(entry.members[0]!.sources[0]!.values.cookieDomain).toBe(".shop.old.example");
  });
  it("preserves unrelated edits and refuses a changed field or shifted array identity", () => {
    const entry = { apps: [{ name: "site", domain: "shop.old.example", seedDemo: false }] };
    const changes = domainChanges(entry, FROM, TO, ["apps"]);
    expect(applyDomainChanges({ apps: [{ ...entry.apps[0]!, seedDemo: true }] }, changes).apps[0]!.seedDemo).toBe(true);
    expect(() => applyDomainChanges({ apps: [{ ...entry.apps[0]!, domain: "someone.example" }] }, changes)).toThrow(/changed/);
    expect(() => applyDomainChanges({ apps: [{ ...entry.apps[0]!, name: "other" }] }, changes)).toThrow(/moved/);
    expect(() => applyDomainChanges({}, [{ path: ["__proto__", "domain"], before: "x", after: "y", anchors: [] }])).toThrow(/unsafe/);
  });
});
