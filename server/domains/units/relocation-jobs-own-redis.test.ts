import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumerDumpJobs, consumerExpectedDumpEntries, consumerRestoreJobs, tarredClaims } from "./relocation-jobs-consumer.ts";
import type { RelocationJob } from "#unit/server/relocation-jobs.ts";

// The own-Redis scripts run by a real `sh -e`, against a box that is a directory and a Redis that is a
// stub: `redis` is the consumer's server, 127.0.0.1 the throwaway one the restore starts from the
// snapshot. The stub's replica takes the throwaway server's keys only where SYNC says it does, so the
// defect of a target that comes up empty is a case here, not a hope.

const FOLDER = "acme/prod/gen-1";
const own = { name: "acme", folder: FOLDER, stage: "prod" as const, namespace: "acme-prod", databases: [], services: ["redis" as const], pvcs: ["redis-data", "uploads"], image: "x", mongodb: "shared" as const, redis: "standalone" as const };
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(): { dir: string; box: string } {
  const dir = mkdtempSync(join(tmpdir(), "own-redis-"));
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
  // State: $W/target.keys is the consumer's server, $W/temp.keys the throwaway one.
  writeFileSync(join(bin, "redis-server"), `#!/bin/sh
dir=""; file=""
while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift ;; --dbfilename) file="$2"; shift ;; esac; shift; done
sed -n 's/^KEYS=//p' "$dir/$file" > "$W/temp.keys"
`, { mode: 0o755 });
  writeFileSync(join(bin, "redis-cli"), `#!/bin/sh
host=redis
while [ $# -gt 0 ]; do case "$1" in -h) host="$2"; shift 2 ;; -p) shift 2 ;; *) break ;; esac; done
[ "$host" = "redis" ] && state="$W/target.keys" || state="$W/temp.keys"
echo "$host $*" >> "$W/calls"
case "$*" in
  "--rdb "*) echo "KEYS=$(cat "$state")" > "$2" ;;
  PING) echo PONG ;;
  DBSIZE) cat "$state" ;;
  "INFO persistence") echo "loading:0" ;;
  "INFO replication") if [ "$host" = "redis" ]; then printf 'role:slave\\nmaster_link_status:up\\nmaster_sync_in_progress:%s\\nslave_repl_offset:7\\n' "\${SYNCING:-0}"; else printf 'role:master\\nmaster_repl_offset:7\\n'; fi ;;
  "REPLICAOF NO ONE") echo OK ;;
  "REPLICAOF "*) [ "$SYNC" = "1" ] && cp "$W/temp.keys" "$W/target.keys"; echo OK ;;
  "CONFIG SET masterauth"*) echo OK ;;
  SHUTDOWN*) : ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "hostname"), "#!/bin/sh\necho 10.1.2.3\n", { mode: 0o755 });
  // TERM_ON_SLEEP stands for the kubelet stopping the job's pod: SIGTERM to the job's shell.
  writeFileSync(join(bin, "sleep"), '#!/bin/sh\n[ -z "$TERM_ON_SLEEP" ] || kill -TERM "$PPID"\n', { mode: 0o755 });
  return { dir, box };
}

function run(w: { dir: string; box: string }, job: RelocationJob, env: Record<string, string>) {
  return spawnSync("sh", ["-ec", job.spec.script.replaceAll("/tmp/", `${w.dir}/`)], {
    env: { ...process.env, PATH: `${join(w.dir, "bin")}:${process.env.PATH}`, BOX: w.box, W: w.dir, STORAGE_BOX_PASSWORD: "p", REDISCLI_AUTH: "pw", ...env },
    encoding: "utf8",
  });
}
const job = (jobs: RelocationJob[], kind: string): RelocationJob => jobs.find((j) => j.spec.name.startsWith(`reloc-${kind}-redis`))!;
const dumpJob = job(consumerDumpJobs({ ...own, registrationYaml: "a: 1\n" }), "dump");
const restoreJob = job(consumerRestoreJobs(own), "restore");

describe("a consumer's own Redis, run by a real shell", () => {
  it("dumps a snapshot to the box and restores it by replication, then makes the target a primary again", () => {
    const w = world();
    writeFileSync(join(w.dir, "target.keys"), "42\n");
    expect(run(w, dumpJob, {}).status).toBe(0);
    expect(readdirSync(join(w.box, FOLDER, "redis"))).toEqual(["dump.rdb"]);
    writeFileSync(join(w.dir, "target.keys"), "0\n");
    const restored = run(w, restoreJob, { SYNC: "1" });
    expect([restored.status, restored.stderr]).toEqual([0, ""]);
    expect(restored.stdout).toContain("COMPLETE redis: 42 keys");
    expect(readFileSync(join(w.dir, "target.keys"), "utf8").trim()).toBe("42");
    const calls = readFileSync(join(w.dir, "calls"), "utf8");
    expect(calls).toContain("redis REPLICAOF 10.1.2.3 6379");
    expect(calls.trim().split("\n").filter((c) => c.startsWith("redis REPLICAOF")).at(-1)).toBe("redis REPLICAOF NO ONE");
  });

  it("PLANTED DEFECT: fails the restore when the target comes up empty, naming the missing keys", () => {
    const w = world();
    writeFileSync(join(w.dir, "target.keys"), "42\n");
    run(w, dumpJob, {});
    writeFileSync(join(w.dir, "target.keys"), "0\n");
    const restored = run(w, restoreJob, { SYNC: "0" });
    expect(restored.status).not.toBe(0);
    expect(restored.stdout).toContain("MISSING redis: the target holds 0 keys of the snapshot's 42");
    // The target is a primary again whatever the outcome, never left replicating the job's server.
    expect(readFileSync(join(w.dir, "calls"), "utf8").trim().split("\n").filter((c) => c.startsWith("redis REPLICAOF")).at(-1)).toBe("redis REPLICAOF NO ONE");
  });

  it("fails, bounded, when the sync never ends", () => {
    const w = world();
    writeFileSync(join(w.dir, "target.keys"), "3\n");
    run(w, dumpJob, {});
    const restored = run(w, restoreJob, { SYNC: "1", SYNCING: "1" });
    expect(restored.status).not.toBe(0);
    expect(restored.stdout).toContain("NO SYNC");
    expect(readFileSync(join(w.dir, "calls"), "utf8").trim().split("\n").filter((c) => c.startsWith("redis REPLICAOF")).at(-1)).toBe("redis REPLICAOF NO ONE");
  });

  it("PLANTED DEFECT: makes the target a primary again and stops when the job's pod is stopped mid-sync", () => {
    const w = world();
    writeFileSync(join(w.dir, "target.keys"), "3\n");
    run(w, dumpJob, {});
    const restored = run(w, restoreJob, { SYNC: "1", SYNCING: "1", TERM_ON_SLEEP: "1" });
    expect([restored.status, restored.stdout.includes("NO SYNC")]).toEqual([143, false]);
    expect(readFileSync(join(w.dir, "calls"), "utf8").trim().split("\n").filter((c) => c.startsWith("redis REPLICAOF")).at(-1)).toBe("redis REPLICAOF NO ONE");
  });

  it("leaves the server's data claim out of the tar and expects a redis entry in the generation", () => {
    expect(tarredClaims(own)).toEqual(["uploads"]);
    expect(consumerExpectedDumpEntries(own)).toContain("redis");
    expect(consumerExpectedDumpEntries({ ...own, redis: "shared" })).not.toContain("redis");
    expect(consumerDumpJobs({ ...own, redis: "shared", registrationYaml: "a: 1\n" }).some((j) => j.spec.name.startsWith("reloc-dump-redis"))).toBe(false);
  });
});
