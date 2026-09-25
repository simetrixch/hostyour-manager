// Write down what a ratchet lets stand TODAY: every hand-spelled copy of a shared/enums.ts set, or,
// with --words, every occurrence of a word a root may not say (tool/word-purity.words for the core,
// plugins/<name>/tool/word-purity.words for each plugin), one record per root.
//
// This is the ratchet. The check each record feeds refuses what is NEW, and lets what is already
// here stand until somebody removes it. A check that refused all of it on the day it was written
// would be red on a tree nobody had a chance to clean, and a red nobody can act on is a red people
// learn to skip.
//
// RUN THIS ONLY TO LOWER THE BAR ONE STEP AT A TIME — after something has been REMOVED, so the
// record stops naming it. Running it to make a new copy or a new word acceptable is how the ratchet
// turns into a rubber stamp: the check then records whatever it finds and refuses nothing at all.
//
//   node fitness/record-known.mjs
//   node fitness/record-known.mjs --words

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { KNOWN_COPIES, REGISTRY, REPOSITORY_ROOT, describeCopy, findCopies } from "./lib/enum-copies.mjs";
import { findOccurrences, roots } from "./lib/word-purity.mjs";

if (process.argv.includes("--words")) {
  for (const { root, list, known } of roots()) {
    const occurrences = findOccurrences(REPOSITORY_ROOT, root);
    const record = {
      what:
        `Every occurrence of a word ${list} lists that stood in ${root === "" ? "the core" : root} when the word check was `
        + "written, as <file>::<word> and its count. The check refuses a count that grows and a key this "
        + "record does not carry, and reports a count the tree no longer reaches. Written by "
        + "node fitness/record-known.mjs --words.",
      occurrences: Object.fromEntries(occurrences),
    };
    writeFileSync(join(REPOSITORY_ROOT, known), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const total = [...occurrences.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(`${known}: ${occurrences.size} file-and-word pair(s), ${total} occurrence(s) recorded.\n`);
  }
} else {
  const found = findCopies();
  const record = {
    what:
      `Every place a closed value set that ${REGISTRY} owns was already spelled a second time by hand `
      + "when this check was written. The check refuses a copy that is not on this list, and reports a "
      + "line of this list that no longer matches anything. Written by node fitness/record-known.mjs; "
      + "a key is the file and the set, never a line, so a copy that moves inside its file stays known.",
    copies: found.map((one) => one.key),
  };

  writeFileSync(join(REPOSITORY_ROOT, KNOWN_COPIES), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const lines = [
    `${KNOWN_COPIES}: ${found.length} copy(ies) recorded.`,
    ...found.map((one) => `  ${describeCopy(one)}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
