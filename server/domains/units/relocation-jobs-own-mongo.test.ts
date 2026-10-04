import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumerDumpJobs, consumerRestoreJobs, consumerVerifyCompletenessJobs } from "./relocation-jobs-consumer.ts";
import type { RelocationJob } from "#unit/server/relocation-jobs.ts";

// The own-MongoDB scripts run by a real `sh -e`, against a box that is a directory and a MongoDB that
// is a stub answering with the databases it is told it holds — so what is pinned is what the shell
// does, not what the script text says.

const FOLDER = "acme/prod/gen-1";
const own = { name: "acme", folder: FOLDER, stage: "prod" as const, namespace: "acme-prod", databases: [], services: [], pvcs: [], image: "x", mongodb: "replicaset" as const };
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(): { dir: string; box: string } {
  const dir = mkdtempSync(join(tmpdir(), "own-mongo-"));
  temps.push(dir);
  const box = join(dir, "box");
  mkdirSync(join(box, FOLDER), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rclone"), `#!/bin/sh
case "$1" in
  obscure) echo x ;;
  lsf)
    shift; inc=""
    if [ "$1" = "--include" ]; then inc="$2"; shift 2; fi
    d="$BOX/\${1#box:}"
    [ -d "$d" ] || { echo "directory not found" >&2; exit 3; }
    for f in $(ls "$d"); do
      if [ -d "$d/$f" ]; then echo "$f/"; elif [ -z "$inc" ]; then echo "$f"; else case "$f" in $inc) echo "$f" ;; esac; fi
    done ;;
  copyto)
    case "$2" in
      box:*) cp "$BOX/\${2#box:}" "$3" ;;
      *) mkdir -p "$(dirname "$BOX/\${3#box:}")"; cp "$2" "$BOX/\${3#box:}" ;;
    esac ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "mongosh"), `#!/bin/sh
case "$*" in
  *listDatabases*) printf '%s\\n' admin config local $DBS ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "mongodump"), `#!/bin/sh
for a in "$@"; do case "$a" in --archive=*) echo dumped > "\${a#--archive=}" ;; esac; done
`, { mode: 0o755 });
  writeFileSync(join(bin, "mongorestore"), `#!/bin/sh
for a in "$@"; do case "$a" in --archive=*) basename "\${a#--archive=}" >> "$RESTORED" ;; esac; done
`, { mode: 0o755 });
  return { dir, box };
}

function run(w: { dir: string; box: string }, job: RelocationJob, dbs: string) {
  return spawnSync("sh", ["-ec", job.spec.script.replaceAll("/tmp/", `${w.dir}/`)], {
    env: { ...process.env, PATH: `${join(w.dir, "bin")}:${process.env.PATH}`, BOX: w.box, DBS: dbs, RESTORED: join(w.dir, "restored"), STORAGE_BOX_PASSWORD: "p" },
    encoding: "utf8",
  });
}
const job = (jobs: RelocationJob[], kind: string): RelocationJob => jobs.find((j) => j.spec.name.startsWith(`reloc-${kind}-mongo`))!;
const dumpJob = job(consumerDumpJobs({ ...own, registrationYaml: "a: 1\n" }), "dump");
const restoreJob = job(consumerRestoreJobs(own), "restore");
const verifyJob = job(consumerVerifyCompletenessJobs(own), "verify");

describe("a consumer's own MongoDB, run by a real shell", () => {
  it("dumps every database but admin, local and config, with the list beside the archives, and verifies them restored", () => {
    const w = world();
    expect(run(w, dumpJob, "shop audit").status).toBe(0);
    expect(readdirSync(join(w.box, FOLDER, "mongo")).sort()).toEqual(["audit.archive", "databases.txt", "shop.archive"]);
    expect(readFileSync(join(w.box, FOLDER, "mongo", "databases.txt"), "utf8")).toBe("shop\naudit\n");
    expect(run(w, restoreJob, "").status).toBe(0);
    expect(readFileSync(join(w.dir, "restored"), "utf8").split("\n").filter(Boolean).sort()).toEqual(["audit.archive", "shop.archive"]);
    const verified = run(w, verifyJob, "shop audit");
    expect(verified.stdout).toContain("COMPLETE mongo");
    expect(verified.status).toBe(0);
  });

  it("dumps and verifies an instance that holds no database of its own yet: an empty list is no failure", () => {
    const w = world();
    const dumped = run(w, dumpJob, "");
    expect(dumped.stderr).toBe("");
    expect(dumped.status).toBe(0);
    expect(readdirSync(join(w.box, FOLDER, "mongo"))).toEqual(["databases.txt"]);
    expect(run(w, restoreJob, "").status).toBe(0);
    expect(existsSync(join(w.dir, "restored"))).toBe(false);
    expect(run(w, verifyJob, "").status).toBe(0);
  });

  it("restores and verifies nothing from a generation written before the instance was dumped whole, instead of failing", () => {
    const w = world();
    writeFileSync(join(w.box, FOLDER, "registration.yaml"), "a: 1\n");
    const restored = run(w, restoreJob, "");
    expect(restored.stderr).toBe("");
    expect(restored.status).toBe(0);
    expect(existsSync(join(w.dir, "restored"))).toBe(false);
    expect(run(w, verifyJob, "").status).toBe(0);
  });

  it("refuses a generation whose list names a database it holds no archive of", () => {
    const w = world();
    expect(run(w, dumpJob, "shop audit").status).toBe(0);
    rmSync(join(w.box, FOLDER, "mongo", "audit.archive"));
    const verified = run(w, verifyJob, "shop audit");
    expect(verified.stdout).toContain("MISSING archive audit");
    expect(verified.status).toBe(1);
  });

  it("holds a listed name against whole archive names, so one name inside another's archive is no match", () => {
    const w = world();
    expect(run(w, dumpJob, "a data").status).toBe(0);
    rmSync(join(w.box, FOLDER, "mongo", "a.archive"));
    const verified = run(w, verifyJob, "a data");
    expect(verified.stdout).toContain("MISSING archive a");
    expect(verified.status).toBe(1);
  });

  it("verifies a generation whose mongo/ holds archives and no list, holding the archives alone", () => {
    const w = world();
    mkdirSync(join(w.box, FOLDER, "mongo"));
    writeFileSync(join(w.box, FOLDER, "mongo", "shop.archive"), "dumped\n");
    const verified = run(w, verifyJob, "shop");
    expect(verified.stdout).toContain("COMPLETE mongo");
    expect(verified.status).toBe(0);
  });
});
