// The laws every registrations writer obeys, factored into reusable primitives (serializePointer /
// parseRegistration / trailer / makeRegistrationGuard) so the consumer
// registrations (registrations.ts) and the tenant-shaped registrations (tenant-registrations.ts) obey
// the same ones:
//   - PATH GUARD: every write path matches its registrations's namespace regex — a traversal or a stray
//     path is a programming error (INTERNAL), never a commit. makeRegistrationGuard(pattern) mints one
//     guard per namespace (registrations/<unit>/… in the consumer registrations; registrations/<guid>/…
//     in the tenant registrations).
//   - SERIALIZE -> VALIDATE -> RE-PARSE: the registration is schema-validated, serialized, and the
//     serialized bytes are re-parsed + re-validated before staging (anti-injection). Values are
//     JSON-encoded, which is valid YAML (JSON ⊂ YAML) and cannot smuggle extra keys; the YAML parse
//     restores nested objects/arrays. The round-trip verifier compares by DEEP equality (canonical
//     JSON), not reference — a nested value (builds[], apps[]) always re-parses to a NEW reference, so
//     a reference `!==` would falsely throw INTERNAL on every nested commit.
//   - RUN-ID TRAILER: every commit message ends with [<runId>] so a commit is always traceable to
//     an approved+succeeded Run.
import type { z } from "zod";
import { parse as parseYaml } from "yaml";
import { errInternal } from "#core/server/kernel/errors.ts";

/** Mint a path guard for one registration namespace: a write path MUST match `pattern` and contain no
 *  `..` traversal, else it is a programming error (INTERNAL), never a commit. Each registrations binds its
 *  own guard to its namespace regex (the consumer `guard` in registrations.ts; the tenant registrations
 *  supplies its own registrations/<guid>/ pattern) so both reuse the identical traversal-rejection. */
export function makeRegistrationGuard(pattern: RegExp, label: string): (path: string) => string {
  return (path: string): string => {
    if (!pattern.test(path) || path.includes("..")) {
      throw errInternal(`path guard: "${path}" is outside ${label}`);
    }
    return path;
  };
}

/** Canonical-JSON deep equality — the serialize round-trip's comparison. A reference `!==` holds
 *  only for flat scalars; a nested value (builds[], apps[]) always re-parses to a NEW reference, so it
 *  must be compared by value. JSON.parse preserves key insertion order, so a plain JSON.stringify
 *  compare is canonical for these re-parsed values. */
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Serialize a validated registration to flat YAML, then re-parse + re-validate the bytes. Each
 *  value is JSON-encoded — valid YAML, injection-safe. The round-trip is verified by DEEP equality so
 *  nested arrays round-trip cleanly instead of throwing on a reference mismatch. Generic over the
 *  schema so the consumer and tenant registries share one serializer. Throws INTERNAL if the round-trip
 *  diverges by value. */
export function serializePointer<T extends object>(schema: z.ZodType<T>, entry: T): string {
  const validated = schema.parse(entry);
  const yaml =
    Object.entries(validated)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") + "\n";
  const reparsed = schema.parse(parseRegistration(yaml)) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(validated)) {
    if (v !== undefined && !deepEqual(reparsed[k], v)) {
      throw errInternal(`registration serialize round-trip diverged at "${k}"`);
    }
  }
  return yaml;
}

/** Parse a registration body back into an object. serializePointer WRITES flat "key: <json>", which
 *  is a SUBSET of YAML, so a body is READ with a real YAML parser — the same asymmetry
 *  tenant-registrations.ts readTenant states for the tenant half, and for its reason: a registration
 *  written by hand, with comments and block-style lists, still folds.
 *
 *  THIS PROCESS IS THE ONLY WRITER OF registrations/**, and that is what the reader may rest on.
 *  `registrations/hostyour-manager/build.yaml` was once rendered onto the branch from a template of
 *  the deployment programs, in a commented dialect the flat reader failed on at its first comment
 *  line — which is where the asymmetry above comes from and why it stays. That template is gone and
 *  no program renders a registration any more: the programs checkout's `onboard-manager` asks this Manager
 *  to onboard its own unit over the route every other consumer takes, so the file arrives in
 *  serializePointer's own dialect, and `deploy-branch` — the one program that writes an install
 *  branch — names no registrations path, down to the directory list its commit row carries. Nothing
 *  puts a hand-written form back over what commitRegistration and flip() wrote.
 *
 *  THE QUOTES AROUND `suspended` BUY NOTHING, which is why flip() writes the boolean. The build
 *  fan-out selects on matchLabels `suspended: "false"` over a git FILES generator (hostyour-cloud
 *  apps/consumer-build/files/applicationset.yaml), and the boolean form serializePointer writes has
 *  matched that selector for every unit in every installation.
 *
 *  THE TENANT PATH IS ON THIS READ TOO. wire-units.ts:615 passes
 *  `() => registrations.listAttestedBuildNames()` with NO exceptUnit, so create-tenant.run.ts:628
 *  scans every unit including this one, and a registration this reader cannot fold refuses the first
 *  tenant as readily as the first other consumer.
 *
 *  A document that is not a mapping is INTERNAL: a registration is an object, so a scalar or a list
 *  at the top level is a file that is not one. */
export function parseRegistration(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw errInternal(`registration is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw errInternal(`registration is not a YAML mapping: ${JSON.stringify(doc) ?? "empty"}`);
  }
  return doc as Record<string, unknown>;
}

/** The [<runId>] commit-message trailer — every registration commit ends with it. */
export const trailer = (runId: string): string => `[${runId}]`;

/** WHY a body failed its schema, as "path message; path message" — one wording for the consumer
 *  registrations and the tenant registrations, so a broken registration reads identically wherever
 *  it is met. */
export const schemaWhy = (err: z.ZodError): string => err.issues.map((i) => i.path.join(".") + " " + i.message).join("; ");
