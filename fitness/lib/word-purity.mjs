// The words the core may not say, found as whole words in every tracked file of the kinds it scans.
// Read by the check (word-purity.test.mjs) and by the recorder (record-known.mjs --words), so the two
// cannot scan differently.
//
// WHAT IT READS: `git ls-files` of the repository, so node_modules, build output and the code graph
// are out by being untracked, and a file nobody committed is not the core's. Held out by name: the
// list and its record, and this detector and its check (they are the words and their probes);
// README.md and LICENSE.md (they name the licensor); deploy/platform.yaml (the organisation's own
// registration of this repository).
//
// WHAT A HIT IS: the word, case-insensitive, where neither side touches a letter or a digit — the
// grammar of the organisation's word-purity audit. `digita` does not report `digitacloud`, and a
// word with a hyphen is matched as written, so `hostyour-cloud` does not report `HOSTYOUR_CLOUD`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WORD_LIST = "tool/word-purity.words";
export const KNOWN_WORDS = "tool/word-purity.known.json";

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|css|sql|yaml|yml|json|html|sh|ps1)$/;
const HELD_OUT = [/^tool\//, /^fitness\/(lib\/)?word-purity\./, /^README\.md$/, /^LICENSE\.md$/, /^deploy\/platform\.yaml$/];

/** Whether the law reads a tracked file at this path. */
export function isScanned(path) {
  return SCANNED.test(path) && !HELD_OUT.some((re) => re.test(path));
}

/** The words of a list text: one per line, `#` starts a comment. An empty list refuses nothing, so
 *  it is refused itself. */
export function parseWordList(text) {
  const words = text.split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
  if (words.length === 0) throw new Error(`${WORD_LIST} lists no word, and a list of none refuses nothing`);
  return words;
}

export function readWordList(root = REPOSITORY_ROOT) {
  return parseWordList(readFileSync(join(root, WORD_LIST), "utf8"));
}

/** Longest first, so `digita-deploy` is counted as itself and not as `digita`. */
function pattern(words) {
  const escaped = [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join("|")})(?![A-Za-z0-9])`, "gi");
}

/** Every word's count of occurrences in one text, keyed `<file>::<word>`. */
export function findOccurrencesInText(file, text, words) {
  const counts = new Map();
  const byLower = new Map(words.map((w) => [w.toLowerCase(), w]));
  for (const m of text.matchAll(pattern(words))) {
    const key = `${file}::${byLower.get(m[0].toLowerCase()) ?? m[0].toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function scannedFiles(root = REPOSITORY_ROOT) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return tracked.filter(isScanned);
}

/** Every occurrence standing in the tree, keyed `<file>::<word>`, sorted. */
export function findOccurrences(root = REPOSITORY_ROOT) {
  const words = readWordList(root);
  const all = new Map();
  for (const file of scannedFiles(root)) {
    for (const [key, count] of findOccurrencesInText(file, readFileSync(join(root, file), "utf8"), words)) all.set(key, count);
  }
  return new Map([...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
