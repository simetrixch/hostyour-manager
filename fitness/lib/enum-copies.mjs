// Find every place a closed value set that shared/enums.ts owns is spelled a second time by hand.
//
// shared/enums.ts is the one home of a closed value set in this repository. A second hand-written
// copy of such a set does not break a build and does not show in a diff, because the copy and the
// original stand in two files nobody opens together. It breaks later, when one of the two grows a
// member: every reader that keys on the other then answers about a value the platform can reach and
// the reader cannot name.
//
// WHAT IS READ is a string literal in the code, through the TypeScript compiler, so a set written
// out in a COMMENT is not a finding — a comment explains, it does not decide anything at runtime.
//
// WHAT COUNTS AS A COPY is a set with the SAME MEMBERS as one enums.ts owns. Order is not part of
// it: a reader that spells the same members in another order holds the same set and breaks the same
// way. A SUBSET is not a copy — naming three of the run kinds is how a caller says "these three",
// and a check that refused it would be refusing the language rather than the duplicate.
//
// A SET OF ONE MEMBER IS NOT COMPARED, in either direction. `APP_SETTLED_STATUS` has one member
// today, and nothing tells an array holding that one word apart from an ordinary value that happens
// to be that word. Comparing it would report every such array and the check would be muted.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The repository root, from this file's own place inside it. */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The one home of a closed value set. Held out of the walk: it is the declaration, not a copy. */
export const REGISTRY = "shared/enums.ts";

/** The ratchet: which copies were already standing when this check was written. */
export const KNOWN_COPIES = "fitness/known-copies.json";

/** The trees that ship. Everything a shipped module can be written in is read. */
const SEARCHED = ["server", "web/src", "gate-runner/src", "shared"];

/** The test surface, which is outside the rule rather than exempt from it: a test names a set
 *  because it is asserting about that set, and a fake models what something else answers. Same four
 *  shapes the boundary law holds out in .dependency-cruiser.cjs (no-unreachable-modules). */
const IS_TEST_SURFACE = (path) =>
  /\.test\.tsx?$/.test(path) || /\.fixture\.ts$/.test(path)
  || /\.suite\.ts$/.test(path) || `/${path}`.includes("/testing/");

/** The smallest set that can be told apart from an ordinary pair of words. */
const SMALLEST_COMPARABLE = 2;

/** Strip `as const` and `satisfies T` so the expression underneath can be read. */
function unwrap(node) {
  let at = node;
  while (at && (ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at))) {
    at = at.expression;
  }
  return at;
}

/** The members of an array literal, when every element of it is a plain string. */
function stringMembers(node) {
  const array = unwrap(node);
  if (!array || !ts.isArrayLiteralExpression(array)) return null;
  const members = [];
  for (const element of array.elements) {
    if (!ts.isStringLiteral(element)) return null;
    members.push(element.text);
  }
  return members;
}

/** The members of a union of string literal types, when every arm of it is one. */
function unionMembers(node) {
  if (!ts.isUnionTypeNode(node)) return null;
  const members = [];
  for (const arm of node.types) {
    if (!ts.isLiteralTypeNode(arm) || !ts.isStringLiteral(arm.literal)) return null;
    members.push(arm.literal.text);
  }
  return members;
}

/** A set as one comparable word: sorted, so two spellings of the same members are one key. */
const fingerprint = (members) => JSON.stringify([...new Set(members)].sort());

function parse(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/**
 * Every closed value set shared/enums.ts owns, as a map from fingerprint to the name it is declared
 * under. An object of arrays (RUN_FAMILY) contributes each of its arrays under `NAME.key` and its
 * own keys under `NAME (keys)`: a reader that spells the family names by hand holds a copy of the
 * family list just as much as one that spells a family's members.
 */
export function ownedSets(root = REPOSITORY_ROOT) {
  const text = readFileSync(join(root, REGISTRY), "utf8");
  const source = parse(REGISTRY, text);
  const owned = new Map();
  const remember = (name, members) => {
    if (members === null || members.length < SMALLEST_COMPARABLE) return;
    const key = fingerprint(members);
    if (!owned.has(key)) owned.set(key, name);
  };

  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      remember(statement.name.text, unionMembers(statement.type));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      remember(name, stringMembers(declaration.initializer));

      const object = unwrap(declaration.initializer);
      if (!object || !ts.isObjectLiteralExpression(object)) continue;
      const keys = [];
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const label = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
        if (label === null) continue;
        keys.push(label);
        remember(`${name}.${label}`, stringMembers(property.initializer));
      }
      remember(`${name} (keys)`, keys);
    }
  }
  return owned;
}

/** The declaration a candidate stands in, so a finding can be read without opening the file. */
function enclosingName(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isTypeAliasDeclaration(at)) return at.name.text;
    if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isPropertySignature(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isPropertyDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isParameter(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
  }
  return "an unnamed set";
}

/** What shape the copy was written in, which is what the reader has to go and change. `as const` and
 *  `satisfies` stand between an array and whatever holds it, so they are stepped over on the way up:
 *  `new Set([...] as const)` is a new Set like any other. */
function shapeOf(node) {
  if (ts.isUnionTypeNode(node)) return "string union";
  let at = node.parent;
  while (at && (ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at))) {
    at = at.parent;
  }
  if (at && ts.isNewExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === "Set") {
    return "new Set";
  }
  return "const array";
}

/**
 * Every hand-spelled copy in one file's text. A finding is keyed by the file and the OWNED SET it
 * copies, never by a line: a copy that moves down its file is the same copy, and a ratchet keyed by
 * line would call it new.
 */
export function findCopiesInText(path, text, owned) {
  const source = parse(path, text);
  const found = new Map();
  const consider = (node, members) => {
    if (members === null || members.length < SMALLEST_COMPARABLE) return;
    const set = owned.get(fingerprint(members));
    if (set === undefined) return;
    const key = `${path}::${set}`;
    if (found.has(key)) return;
    found.set(key, {
      key, file: path, set, line: lineOf(source, node),
      name: enclosingName(node), shape: shapeOf(node),
    });
  };

  const walk = (node) => {
    if (ts.isUnionTypeNode(node)) consider(node, unionMembers(node));
    else if (ts.isArrayLiteralExpression(node)) consider(node, stringMembers(node));
    ts.forEachChild(node, walk);
  };
  walk(source);
  return [...found.values()];
}

/** Every file the rule reads: the four shipped trees, without the test surface and the registry. */
export function scannedFiles(root = REPOSITORY_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const path = relative(root, full).replaceAll("\\", "/");
      if (path === REGISTRY || IS_TEST_SURFACE(path)) continue;
      out.push(path);
    }
  };
  for (const tree of SEARCHED) walk(join(root, tree));
  return out.sort();
}

/** Every hand-spelled copy standing in the tree right now. */
export function findCopies(root = REPOSITORY_ROOT) {
  const owned = ownedSets(root);
  return scannedFiles(root)
    .flatMap((path) => findCopiesInText(path, readFileSync(join(root, path), "utf8"), owned))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** How a finding is put to the person who has to act on it. Not `describe`: every test file in this
 *  repository imports that name from vitest, and a second one would have to be renamed at each. */
export const describeCopy = (one) =>
  `${one.file}:${one.line} — ${one.name} (${one.shape}) spells ${one.set} by hand`;
