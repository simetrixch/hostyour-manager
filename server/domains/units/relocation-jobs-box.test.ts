import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { purgeGenerationJob, verifyDumpJob, type RelocationJob } from "#unit/server/relocation-jobs.ts";
import { consumerClearSourceJobs, consumerGenerationClaimsJob, consumerRestoreJobs, consumerSourceDbListJob, consumerVerifyCompletenessJobs, parseClaimLines } from "./relocation-jobs-consumer.ts";
import { tenantClearSourceJobs, tenantDumpJobs, tenantRestoreJobs, tenantSourceDbListJob, tenantVerifyCompletenessJobs } from "./relocation-jobs-tenant.ts";

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
 *  fails, or `size` where every count fails, or `count` where rclone answers without a count. The
 *  script's /tmp is a directory of this run's own, so a parallel run elsewhere on the machine never
 *  reads its files. */
function run(job: RelocationJob, root: string, opts: { failOn?: string; databases?: string[]; failMongo?: boolean; dropCopy?: boolean } = {}): string {
  const bin = temp("bin-");
  const scratch = temp("tmp-");
  const stub = (name: string, body: string): void => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // The exit codes rclone 1.60.1, the dbtools image's, gives over sftp: 3 for a folder that is not
  // there, and 1 for a box that refuses the login or cannot be reached.
  stub("rclone", `case "$1" in
  obscure) echo obscured ;;
  lsf) p="\${2#box:}"; d="$BOX_ROOT/$p"
       [ "$p" != "$FAIL_ON" ] || { echo "couldn't connect SSH" >&2; exit 1; }
       [ -d "$d" ] || { echo "directory not found" >&2; exit 3; }
       for e in "$d"/*; do [ -e "$e" ] || continue; if [ -d "$e" ]; then echo "$(basename "$e")/"; else basename "$e"; fi; done ;;
  copyto) case "$2" in box:*) cp "$BOX_ROOT/\${2#box:}" "$3" ;; *) cp "$2" "$BOX_ROOT/\${3#box:}" ;; esac ;;
  mkdir) mkdir -p "$BOX_ROOT/\${2#box:}" ;;
  sync) case "$2" in s3:*)
          src="$BOX_ROOT/s3/\${2#s3:}"; dst="$BOX_ROOT/\${3#box:}"; mkdir -p "$dst"
          skipped=0
          for e in "$src"/*; do
            [ -e "$e" ] || continue
            if [ "$DROP_COPY" = "1" ] && [ "$skipped" = "0" ]; then skipped=1; continue; fi
            cp -a "$e" "$dst/"
          done ;;
        esac ;;
  size) [ "$2" != "$FAIL_ON" ] && [ "$FAIL_ON" != "size" ] || { echo "couldn't connect" >&2; exit 1; }
        [ "$FAIL_ON" != "count" ] || { echo '{"bytes":0}'; exit 0; }
        case "$2" in box:*) d="$BOX_ROOT/\${2#box:}" ;; *) d="$BOX_ROOT/s3/\${2#s3:}" ;; esac
        [ -d "$d" ] || { echo "directory not found" >&2; exit 3; }
        echo "{\\"count\\":$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' '),\\"bytes\\":0}" ;;
  purge) rm -rf "$BOX_ROOT/\${2#box:}" ;;
esac`);
  // mongosh fails where FAIL_MONGO is set, writes down every drop, and otherwise lists DATABASES.
  stub("mongosh", `[ -z "$FAIL_MONGO" ] || { echo "MongoNetworkError: connect ECONNREFUSED" >&2; exit 1; }
case "$*" in *dropDatabase*) echo "$*" >> "$BOX_ROOT/dropped" ;; *) for d in $DATABASES; do echo "$d"; done ;; esac`);
  stub("mongorestore", `echo "$*" >> "$BOX_ROOT/restored"`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOX_ROOT: root, FAIL_ON: opts.failOn ?? "", DATABASES: (opts.databases ?? []).join(" "), FAIL_MONGO: opts.failMongo ? "1" : "", DROP_COPY: opts.dropCopy ? "1" : "", STORAGE_BOX_PASSWORD: "x" };
  return execFileSync("sh", ["-ec", job.spec.script.replaceAll("/tmp/", `${scratch}/`)], { env, stdio: "pipe" }).toString();
}

const claimsJob = consumerGenerationClaimsJob({ name: "acme", namespace: "acme-prod", folder: "gen", image: "dbtools" });

describe("counted bucket backup evidence", () => {
  const guid = "zsjs023ctne0";
  const verify = verifyDumpJob({ unit: guid, folder: "gen", namespace: "auth", expected: ["bucket"], image: "dbtools" });
  const dump = tenantDumpJobs({ guid, folder: "gen", stage: "prod", apps: ["web"], identityProvider: "auth", image: "dbtools", registrationYaml: "" }).find((j) => j.spec.name.startsWith("reloc-dump-bucket"))!;
  const evidence = (count: number | undefined, files: Record<string, string> = {}): string => {
    const body = count === undefined ? "" : `${count}\n`;
    const digest = createHash("sha256").update(body).digest("hex");
    const root = box({ "manifest.txt": `${digest}  bucket-objects.txt\n`, ...(count === undefined ? {} : { "bucket-objects.txt": body }), ...files });
    mkdirSync(join(root, "gen", "bucket"), { recursive: true });
    return root;
  };

  it("PLANTED INNOCENT: verifies a proven empty bucket instead of calling its empty listing missing", () => {
    expect(run(verify, evidence(0))).toContain("PRESENT bucket");
  });
  it("verifies a nonempty bucket against the same counted evidence", () => {
    expect(run(verify, evidence(1, { "bucket/photo": "fixture" }))).toContain("PRESENT bucket");
  });
  it("refuses missing count evidence", () => {
    expect(() => run(verify, evidence(undefined))).toThrow();
  });
  it("refuses a missing archive directory even with a zero count", () => {
    const root = evidence(0);
    rmSync(join(root, "gen", "bucket"), { recursive: true });
    expect(() => run(verify, root)).toThrow();
  });
  it("refuses count evidence that differs from its manifest hash", () => {
    const root = evidence(1);
    writeFileSync(join(root, "gen", "bucket-objects.txt"), "0\n");
    expect(() => run(verify, root)).toThrow();
  });
  it("refuses a copied count that differs from the proven source count", () => {
    expect(() => run(verify, evidence(1))).toThrow();
    expect(() => run(verify, evidence(0, { "bucket/photo": "fixture" }))).toThrow();
  });
  it.each(["box:gen/bucket", "count"])("refuses an unavailable or uncounted archive (%s)", (failOn) => {
    expect(() => run(verify, evidence(0), { failOn })).toThrow();
  });
  it("records and hashes the empty source count outside the restored bucket subtree", () => {
    const root = box({ "registration.yaml": "fixture" });
    mkdirSync(join(root, "s3", guid), { recursive: true });
    expect(run(dump, root)).toContain("COUNT bucket source=0 copied=0");
    expect(readFileSync(join(root, "gen", "bucket-objects.txt"), "utf8")).toBe("0\n");
    expect(existsSync(join(root, "gen", "bucket", "bucket-objects.txt"))).toBe(false);
  });
  it("fails the dump when the copy loses an object", () => {
    const root = box({ "registration.yaml": "fixture" });
    mkdirSync(join(root, "s3", guid), { recursive: true });
    writeFileSync(join(root, "s3", guid, "photo"), "fixture");
    expect(() => run(dump, root, { dropCopy: true })).toThrow();
  });
});

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

describe("the Mongo jobs that list the databases themselves", () => {
  const GUID = "zsjs023ctne0";
  const tenant = { guid: GUID, stage: "prod" as const, image: "dbtools" };
  const databases = [`${GUID}_web`, `${GUID}_auth`, "other_core"];

  it("clears a tenant's source of its own databases, as the listing names them, and of nothing else", () => {
    const root = box({});
    expect(run(tenantClearSourceJobs(tenant)[0]!, root, { databases })).toContain(`DROPPED ${GUID}_web`);
    const dropped = readFileSync(join(root, "dropped"), "utf8");
    expect([dropped.includes(`${GUID}_web`), dropped.includes(`${GUID}_auth`), dropped.includes("other_core")]).toEqual([true, true, false]);
  });

  it("fails a tenant's clear-source where Mongo cannot be listed, and drops nothing", () => {
    const root = box({});
    expect(() => run(tenantClearSourceJobs(tenant)[0]!, root, { databases, failMongo: true })).toThrow();
    expect(existsSync(join(root, "dropped"))).toBe(false);
  });

  it("fails the source listing where Mongo cannot be listed, rather than answering no database", () => {
    expect(() => run(tenantSourceDbListJob(tenant), box({}), { databases, failMongo: true })).toThrow();
    expect(run(tenantSourceDbListJob(tenant), box({}), { databases })).toBe(`DB ${GUID}_web\nDB ${GUID}_auth\n`);
  });

  it("PLANTED INNOCENT: a consumer's clear-source drops its registered databases, and fails where Mongo does", () => {
    const job = consumerClearSourceJobs({ name: "acme", stage: "prod", databases: ["acme_main"], services: ["mongodb"], image: "dbtools" })[0]!;
    expect(run(job, box({}))).toContain("DROPPED acme_main");
    expect(() => run(job, box({}), { failMongo: true })).toThrow();
  });
});

describe("the jobs that read a count or a listing into a variable", () => {
  const GUID = "zsjs023ctne0";
  const bucketCheck = (): RelocationJob => tenantVerifyCompletenessJobs({ guid: GUID, folder: "gen", stage: "prod", apps: ["web"], image: "dbtools", identityProvider: "auth" }).find((j) => j.spec.name.startsWith("reloc-verify-bucket"))!;
  const consumerList = (): RelocationJob => consumerSourceDbListJob({ name: "acme", stage: "prod", databases: ["acme_main", "acme_logs"], services: ["mongodb"], image: "dbtools" })!;

  it("PLANTED INNOCENT: the bucket check passes where the box and the target hold the same number of objects", () => {
    expect(run(bucketCheck(), box({ "bucket/a": "", "bucket/b": "", [`../s3/${GUID}/a`]: "", [`../s3/${GUID}/b`]: "" }))).toContain("COMPLETE bucket");
  });

  it("fails the bucket check where a count cannot be read, rather than finding two empty counts equal", () => {
    const root = box({ "bucket/a": "", [`../s3/${GUID}/a`]: "" });
    expect(() => run(bucketCheck(), root, { failOn: "size" })).toThrow(); // neither count can be read
    expect(() => run(bucketCheck(), root, { failOn: `s3:${GUID}` })).toThrow();
  });

  it("fails the bucket check where rclone succeeds but answers no count, as a changed output format would", () => {
    expect(() => run(bucketCheck(), box({ "bucket/a": "", [`../s3/${GUID}/a`]: "" }), { failOn: "count" })).toThrow();
  });

  it("fails the consumer's source listing where Mongo cannot be listed, and names the databases it finds otherwise", () => {
    expect(() => run(consumerList(), box({}), { databases: ["acme_main"], failMongo: true })).toThrow();
    expect(run(consumerList(), box({}), { databases: ["acme_main", "other_db"] })).toBe("DB acme_main\n");
  });
});

describe("purging a generation", () => {
  const purge = (folder: string): RelocationJob => purgeGenerationJob({ unit: "acme", folder, namespace: "acme-prod", image: "dbtools" });

  it("purges a generation that stands on the box, and nothing beside it", () => {
    const root = box({ "consumers/acme/G1/registration.yaml": "", "consumers/acme/G2/registration.yaml": "" });
    expect(run(purge("gen/consumers/acme/G1"), root)).toContain("PURGED gen/consumers/acme/G1");
    expect(existsSync(join(root, "gen/consumers/acme/G1"))).toBe(false);
    expect(existsSync(join(root, "gen/consumers/acme/G2"))).toBe(true);
  });

  it("PLANTED INNOCENT: reports a generation the box does not hold as absent, and succeeds", () => {
    expect(run(purge("gen/consumers/acme/G1"), box({ "consumers/acme/G2/registration.yaml": "" }))).toContain("ABSENT gen/consumers/acme/G1");
  });

  it("fails where the box cannot be read, rather than reporting the generation absent", () => {
    const root = box({ "consumers/acme/G1/registration.yaml": "" });
    expect(() => run(purge("gen/consumers/acme/G1"), root, { failOn: "gen/consumers/acme/G1" })).toThrow();
    expect(existsSync(join(root, "gen/consumers/acme/G1"))).toBe(true);
  });
});
