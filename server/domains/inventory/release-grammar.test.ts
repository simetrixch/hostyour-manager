import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { RELEASE_TAG_RE } from "../../../shared/release.ts";
import { CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH } from "./channel-stages.ts";
import { readReleaseTagFilter, assertMirrorsReleaseGrammar } from "./release-grammar.ts";

// The build plane's copy of the grammar lives in another repository, so nothing here can compare the
// two REAL literals — that comparison is the release.grammar_mirror boot self-check, on a Controller
// that has both sides in front of it. What these tests hold down is the mechanism that check stands
// on: the reader takes the copy off the trunk out of the platform values file, the comparison anchors
// it before comparing, and one character of difference is red.

/** The copy as the platform repo states it: the grammar WITHOUT its anchors. DERIVED, never typed out
 *  — a second literal in this file would be a third place for the grammar to drift. */
const MIRROR = RELEASE_TAG_RE.source.replace(/^\^/, "").replace(/\$$/, "");
/** The same grammar with one segment changed: fourteen digits of timestamp become twelve. The build
 *  plane would then fire on tags this Controller refuses as a pin, and refuse tags it accepts. */
const DRIFTED = MIRROR.replace("{14}", "{12}");

const valuesWith = (filter: string): string =>
  `global:\n  timezone: Europe/Amsterdam\n  releaseTagFilter: '${filter}'\n`;

function trunkCarrying(text: string): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, text);
  return repo;
}

describe("readReleaseTagFilter", () => {
  it("serves the copy off the trunk, verbatim", async () => {
    expect(await readReleaseTagFilter(trunkCarrying(valuesWith(MIRROR)))).toBe(MIRROR);
  });

  it("reads the TRUNK and not the branch this installation keeps its books on", async () => {
    // The grammar is the platform's, not any installation's, so the copy that counts is the one on the
    // trunk — the same branch the channel ceiling is read off. A reader that took the books branch
    // would compare against whatever release that cluster is pinned to.
    const repo = trunkCarrying(valuesWith(MIRROR));
    repo.seed(repo.booksBranch, CHANNEL_STAGES_PATH, valuesWith(DRIFTED));
    expect(await readReleaseTagFilter(repo)).toBe(MIRROR);
  });

  it("fails loud when the file carries no readable filter — unreadable is not agreement", async () => {
    await expect(readReleaseTagFilter(trunkCarrying("global:\n  timezone: Europe/Amsterdam\n")))
      .rejects.toThrow(/no readable global\.releaseTagFilter/);
    await expect(readReleaseTagFilter(trunkCarrying("global:\n  releaseTagFilter: 14\n")))
      .rejects.toThrow(/no readable global\.releaseTagFilter/);
    await expect(readReleaseTagFilter(trunkCarrying("global:\n  releaseTagFilter: ''\n")))
      .rejects.toThrow(/no readable global\.releaseTagFilter/);
  });
});

describe("assertMirrorsReleaseGrammar", () => {
  it("passes the anchorless copy of the grammar this process enforces", () => {
    expect(() => assertMirrorsReleaseGrammar(MIRROR)).not.toThrow();
  });

  it("is RED on ONE character of drift, and names both literals", () => {
    // The counter-probe: without it the assertion above could pass by comparing nothing.
    expect(() => assertMirrorsReleaseGrammar(DRIFTED)).toThrow(/drifted/);
    // Both sides in full, because the fix is a diff of exactly these two (a string matcher is a
    // substring assertion, which is what these two regex literals need).
    expect(() => assertMirrorsReleaseGrammar(DRIFTED)).toThrow(RELEASE_TAG_RE.source);
    expect(() => assertMirrorsReleaseGrammar(DRIFTED)).toThrow(`^${DRIFTED}$`);
  });

  it("is RED on a copy that carries the anchors itself", () => {
    // The file states the INNER pattern so the Trigger's CEL can compose it into a longer ref match.
    // A copy that anchors itself would make that CEL match `^refs/tags/deploy/<stage>/^…$$`, which no
    // tag can be, and the build plane would fire on nothing at all.
    expect(() => assertMirrorsReleaseGrammar(RELEASE_TAG_RE.source)).toThrow(/drifted/);
  });
});
