// THE RULE: the Manager composes no member's path from the member's name. A member's path is the
// product's: its manifest declares it, the registration records it, the tenant row keeps the identity
// provider's, and every address of a member takes the path from there (plugins/unit/shared/unit-host.ts
// tenantMemberUrl). A template that appends `/${member}` to a host is a second copy of the charts'
// path rule, and the two copies disagree for any member whose path is not `/<name>`.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// A host or an origin followed by `/` and a member name placeholder: what composed the identity
// provider's address before the path was recorded (`${...}/${member}`).
const COMPOSED_FROM_NAME = /\}\/\$\{(?:[A-Za-z]+\.)?(?:member|identityProvider|memberName)\}/;

function composedFromName(paths) {
  const out = execFileSync("git", ["grep", "-nP", COMPOSED_FROM_NAME.source, "--", ...paths], { encoding: "utf8", cwd: process.cwd() }).toString();
  return out.split("\n").filter((line) => line !== "" && !/\.test\.[cm]?[jt]sx?:/.test(line));
}

describe("a member's path has one source", () => {
  it("no source file composes a member's address from its name", () => {
    let hits;
    try {
      hits = composedFromName(["server", "plugins", "shared", "web/src", "gate-runner/src"]);
    } catch (err) {
      // git grep exits 1 when nothing matches, which is the answer this test wants.
      if (err.status === 1) hits = [];
      else throw err;
    }
    expect(hits).toEqual([]);
  });

  it("PLANTED DEFECT: the line the Manager composed the identity provider's address with is caught", () => {
    expect(COMPOSED_FROM_NAME.test("return `https://${ownDomain || tenantZone(subdomain, stage, unitApex)}/${member}`;")).toBe(true);
    expect(COMPOSED_FROM_NAME.test("return `https://${host}/${tc.identityProvider}`;")).toBe(true);
    // The innocent case: the recorded path appended as it stands.
    expect(COMPOSED_FROM_NAME.test("return `https://${ownDomain || tenantZone(subdomain, stage, unitApex)}${path === \"/\" ? \"\" : path}`;")).toBe(false);
  });
});
