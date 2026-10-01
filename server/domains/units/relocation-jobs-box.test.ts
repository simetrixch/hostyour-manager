import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RelocationJob } from "#unit/server/relocation-jobs.ts";
import { consumerGenerationClaimsJob, consumerRestoreJobs, consumerVerifyCompletenessJobs, parseClaimLines } from "./relocation-jobs-consumer.ts";
import { tenantRestoreJobs, tenantVerifyCompletenessJobs } from "./relocation-jobs-tenant.ts";

// The jobs that list the Storage Box, run the way the pod runs them (`sh -ec`), against stubs: rclone
// answers off a local directory standing in for the box, mongosh lists the databases a test names, and
// mongorestore writes down what it was handed. A listing the box refuses must fail the job. `sh -e`
// sees only the last command of a pipe, so a listing piped straight into a loop passes over it.

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

/** A box holding `entries` (path to body) under the generation folder `gen`. */
function box(entries: Record<string, string>): string {
  const root = temp("box-");
  for (const [path, body] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, "gen", path)), { recursive: true });
    writeFileSync(join(root, "gen", path), body);
  }
  return root;
}

/** Run `job` with the stubs on PATH and answer its stdout. `failOn` is the one box path whose listing
 *  fails. The script's /tmp is a directory of this run's own, so a parallel run elsewhere on the
 *  machine never reads its files. */
function run(job: RelocationJob, root: string, opts: { failOn?: string; databases?: string[] } = {}): string {
  const bin = temp("bin-");
  const scratch = temp("tmp-");
  const stub = (name: string, body: string): void => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("rclone", `case "$1" in
  obscure) echo obscured ;;
  lsf) p="\${2#box:}"; d="$BOX_ROOT/$p"; [ -d "$d" ] && [ "$p" != "$FAIL_ON" ] || { echo "directory not found" >&2; exit 3; }
       for e in "$d"/*; do [ -e "$e" ] || continue; if [ -d "$e" ]; then echo "$(basename "$e")/"; else basename "$e"; fi; done ;;
  copyto) cp "$BOX_ROOT/\${2#box:}" "$3" ;;
esac`);
  stub("mongosh", `for d in $DATABASES; do echo "$d"; done`);
  stub("mongorestore", `echo "$*" >> "$BOX_ROOT/restored"`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOX_ROOT: root, FAIL_ON: opts.failOn ?? "", DATABASES: (opts.databases ?? []).join(" "), STORAGE_BOX_PASSWORD: "x" };
  return execFileSync("sh", ["-ec", job.spec.script.replaceAll("/tmp/", `${scratch}/`)], { env, stdio: "pipe" }).toString();
}

const claimsJob = consumerGenerationClaimsJob({ name: "acme", namespace: "acme-prod", folder: "gen", image: "dbtools" });

describe("listing the claims a generation holds", () => {
  it("names every claim whose tar the generation holds, and nothing else in its pvc/ folder", () => {
    expect(parseClaimLines(run(claimsJob, box({ "registration.yaml": "", "pvc/queue-mta-0.tar.gz": "", "pvc/notes.txt": "" })))).toEqual(["queue-mta-0"]);
  });

  it("PLANTED INNOCENT: a generation without a pvc/ folder holds no claim, and the job still succeeds", () => {
    expect(parseClaimLines(run(claimsJob, box({ "registration.yaml": "" })))).toEqual([]);
  });

  it("fails where the box cannot be read, rather than reading it as a generation without claims", () => {
    const root = box({ "pvc/queue-mta-0.tar.gz": "" });
    expect(() => run(claimsJob, root, { failOn: "gen/" })).toThrow();
    expect(() => run(claimsJob, root, { failOn: "gen/pvc/" })).toThrow();
  });

  it("refuses a listing that came back without its closing count, or with another number of claims", () => {
    expect(parseClaimLines("CLAIMS 0")).toEqual([]);
    expect(() => parseClaimLines("")).toThrow(/without its closing count/);
    expect(() => parseClaimLines("CLAIM queue-mta-0\nCLAIMS 2")).toThrow(/1 claim\(s\) under a count of 2/);
  });
});

describe("the Mongo jobs that list the generation's archives", () => {
  const GUID = "zsjs023ctne0";
  const consumer = { name: "acme", folder: "gen", stage: "prod" as const, namespace: "acme-prod", databases: ["acme_main"], services: ["mongodb" as const], pvcs: [], image: "dbtools" };
  const tenant = { guid: GUID, folder: "gen", stage: "prod" as const, apps: ["web"], image: "dbtools", identityProvider: "auth" };
  const named = (jobs: RelocationJob[], name: string): RelocationJob => jobs.find((j) => j.spec.name.startsWith(name))!;
  const cases = [
    { job: named(consumerRestoreJobs(consumer), "reloc-restore-mongo"), archive: "acme_main", what: "the consumer's restore" },
    { job: named(consumerVerifyCompletenessJobs(consumer), "reloc-verify-mongo"), archive: "acme_main", what: "the consumer's completeness check" },
    { job: named(tenantRestoreJobs(tenant), "reloc-restore-mongo"), archive: `${GUID}_web`, what: "the tenant's restore" },
    { job: named(tenantVerifyCompletenessJobs(tenant), "reloc-verify-mongo"), archive: `${GUID}_web`, what: "the tenant's completeness check" },
  ];

  it.each(cases)("$what fails where the mongo/ listing fails", ({ job, archive }) => {
    expect(() => run(job, box({ [`mongo/${archive}.archive`]: "" }), { failOn: "gen/mongo/", databases: [archive] })).toThrow();
  });

  it.each(cases)("PLANTED INNOCENT: $what goes through a listing that works", ({ job, archive }) => {
    const root = box({ [`mongo/${archive}.archive`]: "" });
    const out = run(job, root, { databases: [archive] });
    if (job.spec.name.includes("restore")) expect(readFileSync(join(root, "restored"), "utf8")).toContain(`${archive}.archive`);
    else expect(out).toContain("COMPLETE mongo");
  });
});
