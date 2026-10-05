import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumerDumpJobs, consumerExpectedDumpEntries, consumerRestoreJobs, consumerVerifyCompletenessJobs, tarredClaims } from "./relocation-jobs-consumer.ts";
import type { RelocationJob } from "#unit/server/relocation-jobs.ts";

// The own-MariaDB scripts run by a real `sh -e`, against a box that is a directory and a MariaDB that
// is a stub: `mariadb` lists the databases it is told it holds and records what is replayed into it,
// `mariadb-dump` writes the databases it is asked for.

const FOLDER = "acme/prod/gen-1";
const own = { name: "acme", folder: FOLDER, stage: "prod" as const, namespace: "acme-prod", databases: ["shop"], services: ["mariadb" as const], pvcs: ["mariadb-data", "uploads"], image: "x", mongodb: "shared" as const };
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(): { dir: string; box: string } {
  const dir = mkdtempSync(join(tmpdir(), "own-mariadb-"));
  temps.push(dir);
  const box = join(dir, "box");
  mkdirSync(join(box, FOLDER), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rclone"), `#!/bin/sh
case "$1" in
  obscure) echo x ;;
  copyto)
    case "$2" in
      box:*) cp "$BOX/\${2#box:}" "$3" ;;
      *) mkdir -p "$(dirname "$BOX/\${3#box:}")"; cp "$2" "$BOX/\${3#box:}" ;;
    esac ;;
esac
`, { mode: 0o755 });
  // The client reads its password from the file the job writes, never from its command line.
  writeFileSync(join(bin, "mariadb"), `#!/bin/sh
case "$1" in --defaults-extra-file=*) grep -q '^password=pw$' "\${1#--defaults-extra-file=}" || { echo "no password file" >&2; exit 1; } ;; *) echo "password on no file" >&2; exit 1 ;; esac
case "$*" in
  *"SHOW DATABASES"*) printf '%s\\n' information_schema mysql performance_schema sys $DBS ;;
  *"SELECT 1"*) echo 1 ;;
  *) cat >> "$W/replayed" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "mariadb-dump"), `#!/bin/sh
grep -q '^password=pw$' "\${1#--defaults-extra-file=}" || exit 1
shift
while [ $# -gt 0 ]; do case "$1" in --databases) shift; for d in "$@"; do echo "CREATE DATABASE $d;"; done; break ;; esac; shift; done
`, { mode: 0o755 });
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n:\n", { mode: 0o755 });
  return { dir, box };
}

function run(w: { dir: string; box: string }, job: RelocationJob, dbs: string) {
  return spawnSync("sh", ["-ec", job.spec.script.replaceAll("/tmp/", `${w.dir}/`)], {
    env: { ...process.env, PATH: `${join(w.dir, "bin")}:${process.env.PATH}`, BOX: w.box, W: w.dir, DBS: dbs, STORAGE_BOX_PASSWORD: "p", MARIADB_ROOT_PASSWORD: "pw" },
    encoding: "utf8",
  });
}
const job = (jobs: RelocationJob[], kind: string): RelocationJob => jobs.find((j) => j.spec.name.startsWith(`reloc-${kind}-mariadb`))!;
const dumpJob = job(consumerDumpJobs({ ...own, registrationYaml: "a: 1\n" }), "dump");
const restoreJob = job(consumerRestoreJobs(own), "restore");
const verifyJob = job(consumerVerifyCompletenessJobs(own), "verify");

describe("a consumer's own MariaDB, run by a real shell", () => {
  it("dumps every database but the server's own four, replays them on the target, and verifies them there", () => {
    const w = world();
    const dumped = run(w, dumpJob, "shop audit");
    expect([dumped.status, dumped.stderr]).toEqual([0, ""]);
    expect(readdirSync(join(w.box, FOLDER, "mariadb")).sort()).toEqual(["all.sql", "databases.txt"]);
    expect(readFileSync(join(w.box, FOLDER, "mariadb", "databases.txt"), "utf8")).toBe("shop\naudit\n");
    expect(run(w, restoreJob, "").status).toBe(0);
    expect(readFileSync(join(w.dir, "replayed"), "utf8")).toBe("CREATE DATABASE shop;\nCREATE DATABASE audit;\n");
    const verified = run(w, verifyJob, "shop audit");
    expect([verified.status, verified.stdout.trim().split("\n").at(-1)]).toEqual([0, "COMPLETE mariadb"]);
  });

  it("PLANTED DEFECT: fails the verify when the target lacks a dumped database, naming it", () => {
    const w = world();
    run(w, dumpJob, "shop audit");
    const verified = run(w, verifyJob, "shop");
    expect(verified.status).not.toBe(0);
    expect(verified.stdout).toContain("MISSING database audit");
  });

  it("dumps and verifies a server that holds no database of its own yet: an empty list is no failure", () => {
    const w = world();
    expect(run(w, dumpJob, "").status).toBe(0);
    expect(readFileSync(join(w.box, FOLDER, "mariadb", "databases.txt"), "utf8")).toBe("");
    expect(run(w, restoreJob, "").status).toBe(0);
    expect(run(w, verifyJob, "").stdout).toContain("COMPLETE mariadb");
  });

  it("leaves the server's data claim out of the tar and expects a mariadb entry in the generation", () => {
    expect(tarredClaims(own)).toEqual(["uploads"]);
    expect(consumerExpectedDumpEntries(own)).toContain("mariadb");
    expect(consumerExpectedDumpEntries({ ...own, services: [] })).not.toContain("mariadb");
  });
});
