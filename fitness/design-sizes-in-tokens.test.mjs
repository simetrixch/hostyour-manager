// THE RULE: design sizes in web/src/ds/*.css live in tokens.css, not as literals.
// Every length literal (a number with px, rem or em, optional sign and decimals; not 0 alone)
// reads its role from tokens.css, unless it is a named constant with an explicit reason, or it
// stands in an @media condition, which cannot read a custom property.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = process.cwd();
const DS_DIR = join(REPOSITORY_ROOT, "web/src/ds");

// A constant is one declaration of one file, matched whole, so the same length elsewhere is still refused.
const NAMED_CONSTANTS = [
  {
    file: "web/src/ds/screens.css",
    declaration: "top: 1.75rem",
    reason: "the connector's ends sit between this step's marker and the next one's, which the step's own padding sets",
  },
  {
    file: "web/src/ds/screens.css",
    declaration: "bottom: -0.4375rem",
    reason: "the connector's ends sit between this step's marker and the next one's, which the step's own padding sets",
  },
];

const LENGTH_LITERAL_REGEX = /(?:^|[^\w-])([-+]?\d*\.?\d+(?:px|rem|em))\b/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat(match.split("\n").length - 1));
}

function describeHit(hit) {
  return `${hit.file}:${hit.line} (${hit.literal}) in "${hit.text}"`;
}

function findLengthLiteralsInText(filePath, text, constants = NAMED_CONSTANTS) {
  const stripped = stripComments(text);
  const lines = stripped.split("\n");
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    // A breakpoint cannot be a token: an @media condition does not resolve var(), so only its condition is skipped.
    const line = lines[i].replace(/@media[^{]*/, "");
    const lineNum = i + 1;
    let m;
    LENGTH_LITERAL_REGEX.lastIndex = 0;
    while ((m = LENGTH_LITERAL_REGEX.exec(line)) !== null) {
      const literal = m[1];
      const declaration = line.trim().replace(/;$/, "");
      const isConstant = constants.some((c) => filePath === c.file && declaration === c.declaration);
      if (!isConstant) {
        hits.push({
          file: filePath,
          line: lineNum,
          literal,
          text: line.trim(),
        });
      }
    }
  }
  return hits;
}

function findLengthLiterals(constants = NAMED_CONSTANTS) {
  const files = readdirSync(DS_DIR).filter((f) => f.endsWith(".css") && f !== "tokens.css");
  const allHits = [];
  for (const f of files.sort()) {
    const relPath = `web/src/ds/${f}`;
    const text = readFileSync(join(DS_DIR, f), "utf8");
    allHits.push(...findLengthLiteralsInText(relPath, text, constants));
  }
  return allHits;
}

describe("design sizes live in tokens.css", () => {
  it("reads every web/src/ds/*.css except tokens.css", () => {
    const files = readdirSync(DS_DIR).filter((f) => f.endsWith(".css") && f !== "tokens.css");
    expect(files.sort()).toEqual(["screens.css", "shell.css", "ui.css"]);
  });

  it("finds a planted length literal and passes tokens and zero", () => {
    const plantedBad = "border: 1px solid var(--border);";
    const plantedToken = "border: var(--stroke-hairline) solid var(--border);";
    const plantedZero = "margin: 0; padding: 0;";
    expect(findLengthLiteralsInText("test.css", plantedBad)).toEqual([
      expect.objectContaining({ literal: "1px" }),
    ]);
    expect(findLengthLiteralsInText("test.css", plantedToken)).toEqual([]);
    expect(findLengthLiteralsInText("test.css", plantedZero)).toEqual([]);
  });

  it("lets a named constant and a breakpoint through, and nothing that only resembles them", () => {
    const file = "web/src/ds/screens.css";
    expect(findLengthLiteralsInText(file, "  top: 1.75rem;")).toEqual([]);
    expect(findLengthLiteralsInText(file, "@media (width >= 768px) {")).toEqual([]);
    // PLANTED DEFECT: the same length in another declaration, or the constant in another file.
    expect(findLengthLiteralsInText(file, "  margin-top: 1.75rem;")).toEqual([expect.objectContaining({ literal: "1.75rem" })]);
    expect(findLengthLiteralsInText("web/src/ds/ui.css", "  top: 1.75rem;")).toEqual([expect.objectContaining({ literal: "1.75rem" })]);
    expect(findLengthLiteralsInText(file, "@media (width >= 768px) { .x { width: 2rem; } }")).toEqual([expect.objectContaining({ literal: "2rem" })]);
  });

  it("refuses every length literal outside named constants", () => {
    const unexcused = findLengthLiterals();
    expect(
      unexcused.map(describeHit),
      `design sizes must read tokens from tokens.css; found literals: ${unexcused.map(describeHit).join("; ")}`,
    ).toEqual([]);
  });
});
