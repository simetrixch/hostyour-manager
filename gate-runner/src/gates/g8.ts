// gate-runner/src/gates/g8.ts
// G8 "image discipline" (hard). Every container image rendered by the chart must be provably
// non-mutable-by-tag. We can only reason offline over the text of the reference, so we PASS a
// reference that either carries a tag other than "latest" or is pinned by an @<algo>:<hex> digest,
// and FAIL a reference with no tag (implicit :latest) or an explicit :latest — a mutable tag can be
// repointed at fresh content after validation, breaking reproducibility. A digest wins regardless
// of the tag, because it names the exact bytes. The reference is UNTRUSTED parsed YAML, so every
// nested field is read behind typeof / Array.isArray guards.
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence } from "../../../shared/gates.ts";
import { pass, fail } from "./result.ts";

// A PodSpec exposes its images under these three sibling arrays (containers, initContainers,
// ephemeralContainers). We look for them at every object node of every rendered doc, which reaches
// a bare Pod (spec.*), a workload (spec.template.spec.*) and a CronJob (spec.jobTemplate.spec.
// template.spec.*) without hard-coding any one shape.
const CONTAINER_KEYS = ["containers", "initContainers", "ephemeralContainers"] as const;

// Guard against a pathological hostile document nesting deeply enough to blow the stack. A parsed
// manifest is never legitimately this deep; the WeakSet already stops shared-reference cycles.
const MAX_DEPTH = 100;

const EVIDENCE_VALUE_MAX = 256; // GateEvidence.value is runner-truncated at 256 chars.
const MAX_LISTED = 8; // how many offending refs we spell out inline in found/reason.
const MAX_EVIDENCE = 20; // GateEvidence array cap (shared/gates.ts).

interface FoundImage {
  ref: string;
  docIndex: number;
  kind: string;
  name: string;
  fieldPath: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walk one rendered doc, collecting every string `image` that sits inside a container array. */
function collectImages(
  node: unknown,
  path: string,
  doc: RenderedDoc,
  out: FoundImage[],
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectImages(node[i], `${path}[${i}]`, doc, out, seen, depth + 1);
    }
    return;
  }
  if (!isRecord(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  for (const key of CONTAINER_KEYS) {
    const arr = node[key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (isRecord(c) && typeof c.image === "string") {
        out.push({
          ref: c.image,
          docIndex: doc.docIndex,
          kind: doc.kind,
          name: doc.name,
          fieldPath: `${path ? `${path}.` : ""}${key}[${i}].image`,
        });
      }
    }
  }

  for (const key of Object.keys(node)) {
    collectImages(node[key], path ? `${path}.${key}` : key, doc, out, seen, depth + 1);
  }
}

// A real content digest is `@<algorithm>:<hex>` where the algorithm is lowercase-alphanumeric with
// optional [.+_-] separators (e.g. "sha256", "sha512") and the encoded value is hex of at least 32
// chars (sha256 => 64). Anchored to the end of the reference, so a trailing bogus token like
// "@0:0" or a short/non-hex value ("@sha256:deadbeef") is NOT accepted as pinning.
const DIGEST_RE = /@[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;

/** True when the reference is pinned by a real @<algorithm>:<hex> digest (bytes named exactly). */
function hasDigest(ref: string): boolean {
  return DIGEST_RE.test(ref);
}

/** The tag of a reference (the segment after the last colon that comes after the last slash), or
 *  null when there is none. The digest part (from the first `@`) is stripped first, since it may
 *  itself contain a colon. A registry host:port colon lives before the last slash and is ignored. */
function tagOf(ref: string): string | null {
  const at = ref.indexOf("@");
  const namePart = at >= 0 ? ref.slice(0, at) : ref;
  const lastSegment = namePart.slice(namePart.lastIndexOf("/") + 1);
  const colon = lastSegment.lastIndexOf(":");
  if (colon < 0) return null;
  return lastSegment.slice(colon + 1);
}

/** Offline immutability verdict for one reference. */
function isProvablyImmutable(ref: string): boolean {
  if (hasDigest(ref)) return true;
  const tag = tagOf(ref);
  if (tag === null || tag.length === 0) return false; // no tag => implicit :latest
  return tag !== "latest";
}

/** One short, human phrase naming why a reference is mutable, for the found/reason sentences. */
function problemOf(ref: string): string {
  const tag = tagOf(ref);
  if (tag === null || tag.length === 0) return "no tag, so it resolves to the mutable :latest";
  if (tag === "latest") return "the mutable :latest tag";
  return "a mutable tag with no pinning digest";
}

function describe(im: FoundImage): string {
  return `"${im.ref}" (${im.kind}/${im.name} at ${im.fieldPath}: ${problemOf(im.ref)})`;
}

const EXPECTED =
  "Every container image reference (in containers, initContainers, and ephemeralContainers of " +
  'every rendered pod spec) carries a tag != latest, or a digest (immutability cannot be proven ' +
  "offline; block the provably-mutable cases).";

export const g8: CheckGate = {
  id: "G8",
  title: "image discipline",
  severity: "hard",
  check(ctx: GateContext) {
    const images: FoundImage[] = [];
    for (const doc of ctx.rendered) {
      if (isRecord(doc.raw)) {
        collectImages(doc.raw, "", doc, images, new WeakSet<object>(), 0);
      }
    }

    const bad = images.filter((im) => !isProvablyImmutable(im.ref));

    if (bad.length === 0) {
      const found =
        images.length === 0
          ? `No container images were found across the ${ctx.rendered.length} rendered document(s), so nothing can pull a mutable tag.`
          : `All ${images.length} container image reference(s) across the rendered pod specs carry a tag != latest or an @digest.`;
      return pass({ id: "G8", title: "image discipline", severity: "hard", expected: EXPECTED, found });
    }

    const listed = bad.slice(0, MAX_LISTED).map(describe).join("; ");
    const more = bad.length > MAX_LISTED ? ` (and ${bad.length - MAX_LISTED} more)` : "";
    const found = `${bad.length} of ${images.length} container image reference(s) cannot be proven immutable: ${listed}${more}.`;
    const reason =
      `${bad.length} rendered container image reference(s) use a mutable tag with no pinning digest: ${listed}${more}. ` +
      "A mutable tag can be repointed at different content after this validation, so the deployed bytes are not reproducible; " +
      "pin each reference to a specific tag other than latest, or append an @sha256 digest.";

    const evidence: GateEvidence[] = bad.slice(0, MAX_EVIDENCE).map((im) => ({
      source: "rendered",
      docIndex: im.docIndex,
      kind: im.kind,
      name: im.name,
      fieldPath: im.fieldPath,
      value: im.ref.slice(0, EVIDENCE_VALUE_MAX),
    }));

    return fail({ id: "G8", title: "image discipline", severity: "hard", expected: EXPECTED, found, reason, evidence });
  },
};
