// THE RULE: a root says no word of its list — the core none of tool/word-purity.words (no customer,
// no person, no sibling repository, no family its plugins carry, no tool it does not drive), and each
// plugin none of plugins/<name>/tool/word-purity.words (no customer, and no family that stands on it).
//
// The occurrences standing on the day a root's check landed are recorded in the word-purity.known.json
// beside its list and are let through, so the rule holds from that day on without asking anybody to
// clean the tree first. A NEW occurrence is refused. A recorded one that is gone is refused too, as
// stale: the record then says more than the tree does, and it only shrinks by running
// `node fitness/record-known.mjs --words` after a change removed an occurrence.
//
// The probes below plant a hit and an innocent neighbour for every word, the way the organisation's
// word-purity audit proves itself: a scanner that stopped seeing a word would report the tree clean.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_WORDS, REPOSITORY_ROOT, WORD_LIST,
  findOccurrences, findOccurrencesInText, isScanned, parseWordList, readWordList, rootOf, roots, scannedFiles,
} from "./lib/word-purity.mjs";

const known = (file) => JSON.parse(readFileSync(join(REPOSITORY_ROOT, file), "utf8")).occurrences;

describe("the core says none of the words on its list", () => {
  it("reads the shipped trees, so a clean answer means the tree was looked at", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(300);
    for (const tree of ["server/", "shared/", "web/src/", "gate-runner/src/"]) {
      expect(files.some((one) => one.startsWith(tree)), tree).toBe(true);
    }
    expect(files).not.toContain(WORD_LIST);
    expect(files).not.toContain(KNOWN_WORDS);
    expect(files.filter((one) => one.startsWith("plugins/"))).toEqual([]);
  });
});

describe("each plugin says none of the words on its own list", () => {
  const plugins = roots().filter((r) => r.root !== "");

  it("finds the plugins the tree carries, each with a list of its own", () => {
    expect(plugins.map((r) => r.root)).toContain("plugins/unit/");
    for (const { root } of plugins) expect(readWordList(REPOSITORY_ROOT, root).length, root).toBeGreaterThan(0);
  });

  it("reads each plugin's own files and nothing of the core's, so a clean answer means the plugin was looked at", () => {
    for (const { root, list, known: record } of plugins) {
      const files = scannedFiles(REPOSITORY_ROOT, root);
      expect(files.length, root).toBeGreaterThan(0);
      expect(files.every((one) => one.startsWith(root)), root).toBe(true);
      expect(files).not.toContain(list);
      expect(files).not.toContain(record);
    }
  });
});

describe("every root's record", () => {
  it("refuses an occurrence the record does not carry, and a record that says more than the tree", () => {
    for (const { root, known: record } of roots()) {
      const standing = findOccurrences(REPOSITORY_ROOT, root);
      const recorded = known(record);
      const grown = [...standing.entries()].filter(([key, count]) => count > (recorded[key] ?? 0)).map(([key, count]) => `${key} (${recorded[key] ?? 0} → ${count})`);
      expect(grown, `${record}: a new occurrence of a word this root may not say — name the thing for what it is, or move it where it belongs`).toEqual([]);
      const stale = Object.entries(recorded).filter(([key, count]) => (standing.get(key) ?? 0) < count).map(([key, count]) => `${key} (${count} → ${standing.get(key) ?? 0})`);
      expect(stale, `${record} carries more than the tree — lower it with node fitness/record-known.mjs --words`).toEqual([]);
    }
  });
});

describe("PROBES: the scan sees what it must refuse, and nothing else", () => {
  const words = readWordList();

  it("reports every word planted as a word, whatever its case", () => {
    for (const word of words) {
      expect(findOccurrencesInText("x.ts", `const a = "${word}";`, words).get(`x.ts::${word}`), word).toBe(1);
      expect(findOccurrencesInText("x.ts", `// ${word.toUpperCase()}`, words).get(`x.ts::${word}`), word).toBe(1);
    }
  });

  it("reports a word standing before a hyphen, before an underscore, and after one", () => {
    for (const word of words) {
      for (const text of [`${word}-addr`, `${word}_addr`, `the_${word}`]) {
        expect(findOccurrencesInText("x.ts", text, words).get(`x.ts::${word}`), `${text}`).toBe(1);
      }
    }
  });

  it("PLANTED INNOCENT: a word inside a longer word is none", () => {
    for (const word of words) {
      expect(findOccurrencesInText("x.ts", `before${word}after`, words).size, word).toBe(0);
    }
  });

  it("matches a hyphenated word as written: the underscore spelling is not the same word", () => {
    expect(findOccurrencesInText("x.ts", "hostyour-cloud", words).get("x.ts::hostyour-cloud")).toBe(1);
    expect(findOccurrencesInText("x.ts", "HOSTYOUR_CLOUD", words).size).toBe(0);
  });

  it("reads a file however deep it stands, and holds every list's own directory out", () => {
    expect(isScanned("server/a/b/c/d/e.ts")).toBe(true);
    expect(isScanned("web/src/a/b/c.tsx")).toBe(true);
    expect(isScanned("server/db/migrations/0000_baseline.sql")).toBe(true);
    expect(isScanned("plugins/unit/server/a/b.ts")).toBe(true);
    expect(isScanned("tool/anything.json")).toBe(false);
    expect(isScanned(WORD_LIST)).toBe(false);
    expect(isScanned(`plugins/unit/${WORD_LIST}`)).toBe(false);
    expect(isScanned(`plugins/unit/${KNOWN_WORDS}`)).toBe(false);
    expect(isScanned("fitness/word-purity.test.mjs")).toBe(false);
    expect(isScanned("fitness/lib/word-purity.mjs")).toBe(false);
  });

  it("files a path under the root that holds it: a plugin's file is its plugin's, never the core's", () => {
    expect(rootOf("server/boot/wire.ts")).toBe("");
    expect(rootOf("plugins/unit/server/plugin.ts")).toBe("plugins/unit/");
    expect(rootOf("plugins/unit/web/plugin.ts")).toBe("plugins/unit/");
  });

  it("refuses an empty list, because a list of none refuses nothing", () => {
    expect(() => parseWordList("# only a comment\n\n")).toThrow(/lists no word/);
  });
});
