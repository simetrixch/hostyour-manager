// Write down every hand-spelled copy of a shared/enums.ts set that is standing in the tree TODAY.
//
// This is the ratchet. The check this file feeds refuses a copy that is NEW, and lets the ones
// already here stand until somebody removes them. A check that refused all of them on the day it
// was written would be red on a tree nobody had a chance to clean, and a red nobody can act on is a
// red people learn to skip.
//
// RUN THIS ONLY TO LOWER THE BAR ONE STEP AT A TIME — after a copy has been REMOVED, so the list
// stops naming it. Running it to make a new copy acceptable is how the ratchet turns into a
// rubber stamp: the check then records whatever it finds and refuses nothing at all.
//
//   node fitness/record-known.mjs

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { KNOWN_COPIES, REGISTRY, REPOSITORY_ROOT, describeCopy, findCopies } from "./lib/enum-copies.mjs";

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
