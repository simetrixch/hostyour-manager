// THE RULE: a closed value set is declared once, in shared/enums.ts, and nowhere else.
//
// This check goes red on a copy that is NEW. The copies already standing when it was written are
// listed in fitness/known-copies.json and are let through, so the rule starts holding today without
// asking anybody to clean a tree first. A listed copy that has been REMOVED is reported as well —
// not as a failure of the tree but of the list, because a line that matches nothing goes on
// answering for the next thing written under that name.
//
// The detector is in lib/enum-copies.mjs and says there what it reads and what it cannot reach.
// Two of the cases below are innocent ones: they prove the scan still SEES what it is meant to
// refuse. A scanner that had stopped seeing string literals would report the tree clean while every
// module spelled what it liked, and nothing else here would notice.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_COPIES, REGISTRY, REPOSITORY_ROOT,
  describeCopy, findCopies, findCopiesInText, ownedSets, scannedFiles,
} from "./lib/enum-copies.mjs";

const known = () => {
  const text = readFileSync(join(REPOSITORY_ROOT, KNOWN_COPIES), "utf8");
  return new Set(JSON.parse(text).copies);
};

describe("closed value sets are declared once, in shared/enums.ts", () => {
  it("reads the four shipped trees, so a clean answer means the tree was looked at", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(200);
    for (const tree of ["server/", "web/src/", "gate-runner/src/", "shared/"]) {
      expect(files.some((one) => one.startsWith(tree)), tree).toBe(true);
    }
    // The registry is the one file held out, and holding it out only works while it is there.
    expect(files).not.toContain(REGISTRY);
    expect(readFileSync(join(REPOSITORY_ROOT, REGISTRY), "utf8"))
      .toContain("The single home of every enum literal");
  });

  it("knows the sets the registry owns, including the ones inside RUN_FAMILY", () => {
    const names = new Set(ownedSets().values());
    for (const name of ["RUN_KIND", "RUN_STATUS", "STAGE", "APP_PROVENANCE", "SERVER_ROLE"]) {
      expect(names, name).toContain(name);
    }
    // RUN_FAMILY is an object of arrays: each family's members are a set of their own, and so is
    // the list of family names. A reader that spells either by hand holds a copy.
    expect(names).toContain("RUN_FAMILY.cluster");
    expect(names).toContain("RUN_FAMILY (keys)");
  });

  it("finds a copy put in front of it, so a clean answer is a refusal and not a blind scan", () => {
    const owned = ownedSets();
    const copy = `
      export type Status = "planning" | "planned" | "approved" | "running"
        | "succeeded" | "failed" | "cancelled";
      export const OUT_OF_ORDER = ["prod", "dev", "test"];
      export const SEEN = new Set(["manager", "adopted"]);
    `;
    const found = findCopiesInText("web/src/invented.ts", copy, owned);
    expect(found.map((one) => one.set).sort()).toEqual(["APP_PROVENANCE", "RUN_STATUS", "STAGE"]);
    // A different order is the same set: the reader holds the same members and breaks the same way.
    expect(found.find((one) => one.set === "STAGE").shape).toBe("const array");
    expect(found.find((one) => one.set === "APP_PROVENANCE").shape).toBe("new Set");
  });

  it("lets a subset stand, because naming three members is how a caller says those three", () => {
    const owned = ownedSets();
    const subset = `export const SOME = ["cluster-adopt", "cluster-redeploy"];`;
    expect(findCopiesInText("server/invented.ts", subset, owned)).toEqual([]);
  });

  it("no set the registry owns is spelled a second time by hand", () => {
    const listed = known();
    const added = findCopies().filter((one) => !listed.has(one.key));
    expect(
      added.map(describeCopy),
      `a closed value set is declared once, in ${REGISTRY} — import it instead of writing the `
      + `members again: ${added.map(describeCopy).join("; ")}`,
    ).toEqual([]);
  });

  it("names a listed copy that is gone, so the list cannot outlive what it excuses", () => {
    const standing = new Set(findCopies().map((one) => one.key));
    const stale = [...known()].filter((key) => !standing.has(key));
    expect(
      stale,
      `${KNOWN_COPIES} names a copy that is not there any more. Run `
      + `\`node fitness/record-known.mjs\` to take it off the list: ${stale.join("; ")}`,
    ).toEqual([]);
  });
});
