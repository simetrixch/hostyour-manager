// The words a root may not say, found as whole words in every tracked file of the kinds it scans.
// Read by the check (word-purity.test.mjs) and by the recorder (record-known.mjs --words), so the two
// cannot scan differently.
//
// ONE ROOT, ONE LIST. The core is one root: every tracked file outside plugins/, read against
// tool/word-purity.words. Each plugin is a root of its own: every tracked file under plugins/<name>/,
// read against plugins/<name>/tool/word-purity.words. A root's record stands beside its list. A
// plugin says what the core may not (its family), and the core must not say what a plugin may, so
// neither list can stand for the other.
//
// WHAT IT READS: `git ls-files` of the repository, so node_modules, build output and the code graph
// are out by being untracked, and a file nobody committed is not the core's. Held out by name: every
// root's list and record, and this detector and its check (they are the words and their probes);
// README.md and LICENSE.md (they name the licensor); deploy/platform.yaml (the organisation's own
// registration of this repository).
//
// WHAT A HIT IS: the word, case-insensitive, where neither side touches a letter or a digit — the
// grammar of the organisation's word-purity audit. `digita` does not report `digitacloud`, and a
// word with a hyphen is matched as written, so `hostyour-cloud` does not report `HOSTYOUR_CLOUD`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WORD_LIST = "tool/word-purity.words";
export const KNOWN_WORDS = "tool/word-purity.known.json";

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|css|sql|yaml|yml|json|html|sh|ps1)$/;
const HELD_OUT = [/^tool\//, /^plugins\/[^/]+\/tool\//, /^fitness\/(lib\/)?word-purity\./, /^README\.md$/, /^LICENSE\.md$/, /^deploy\/platform\.yaml$/];
const PLUGIN = /^plugins\/([^/]+)\//;

/** The root a path belongs to: "" for the core, `plugins/<name>/` for a plugin. */
export function rootOf(path) {
  const m = PLUGIN.exec(path);
  return m ? `plugins/${m[1]}/` : "";
}

/** Whether the law reads a tracked file at this path, under whichever root holds it. */
export function isScanned(path) {
  return SCANNED.test(path) && !HELD_OUT.some((re) => re.test(path));
}

/** The words of a list text: one per line, `#` starts a comment. An empty list refuses nothing, so
 *  it is refused itself. */
export function parseWordList(text, list = WORD_LIST) {
  const words = text.split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
  if (words.length === 0) throw new Error(`${list} lists no word, and a list of none refuses nothing`);
  return words;
}

/** Every root the tree carries: the core, and each directory under plugins/, each with the paths of
 *  its list and its record. A plugin without a list is refused: its files would otherwise be read by
 *  no list at all. */
export function roots(repository = REPOSITORY_ROOT) {
  const plugins = [...new Set(trackedFiles(repository).map(rootOf).filter(Boolean))].sort();
  for (const root of plugins) {
    if (!existsSync(join(repository, root, WORD_LIST))) throw new Error(`${root} carries no ${root}${WORD_LIST}, so no list reads it`);
  }
  return ["", ...plugins].map((root) => ({ root, list: `${root}${WORD_LIST}`, known: `${root}${KNOWN_WORDS}` }));
}

export function readWordList(repository = REPOSITORY_ROOT, root = "") {
  const list = `${root}${WORD_LIST}`;
  return parseWordList(readFileSync(join(repository, list), "utf8"), list);
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

function trackedFiles(repository) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean);
}

/** The files one root reads. */
export function scannedFiles(repository = REPOSITORY_ROOT, root = "") {
  return trackedFiles(repository).filter((file) => isScanned(file) && rootOf(file) === root);
}

/** Every occurrence standing in one root, keyed `<file>::<word>`, sorted. */
export function findOccurrences(repository = REPOSITORY_ROOT, root = "") {
  const words = readWordList(repository, root);
  const all = new Map();
  for (const file of scannedFiles(repository, root)) {
    for (const [key, count] of findOccurrencesInText(file, readFileSync(join(repository, file), "utf8"), words)) all.set(key, count);
  }
  return new Map([...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
