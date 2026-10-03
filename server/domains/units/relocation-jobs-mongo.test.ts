import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mongodumpLine } from "#unit/server/relocation-jobs.ts";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dump(fail: boolean, password: string) {
  const dir = mkdtempSync(join(tmpdir(), "dump-mongo-"));
  temps.push(dir);
  writeFileSync(join(dir, "mongodump"), `#!/bin/sh
case "$*" in *--quiet*) exit 7 ;; esac
for n in $(seq 1 30); do echo "progress $n" >&2; done
echo "error: $MONGO_ROOT_PASSWORD / $MONGO_ROOT_PASSWORD" >&2
exit ${fail ? 7 : 0}
`, { mode: 0o755 });
  const result = spawnSync("sh", ["-ec", mongodumpLine("workshop", "/dev/null").replaceAll("/tmp/", `${dir}/`)], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MONGO_HOST: "mongo", MONGO_ROOT_PASSWORD: password },
    encoding: "utf8",
  });
  return { result, dir };
}

describe("mongodump failure diagnostics", () => {
  it.each(["secret[.*]$", "R"])("preserves failure and prints a bounded password-free stderr tail (%s)", (password) => {
    const { result } = dump(true, password);
    expect(result.status).toBe(7);
    const lines = result.stdout.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["DUMP workshop", "FAILED mongodump workshop, exit 7"]);
    expect(lines).toHaveLength(22);
    expect(lines[2]).toBe("progress 12");
    expect(lines.at(-1)).toBe("error: [REDACTED] / [REDACTED]");
    expect(result.stderr).toBe("");
  });

  it("keeps successful dumps quiet and removes their stderr file", () => {
    const { result, dir } = dump(false, "private");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("DUMP workshop\n");
    expect(result.stderr).toBe("");
    expect(existsSync(join(dir, "mongodump.stderr"))).toBe(false);
  });

  it("withholds stderr for multiline credentials without changing the dump failure", () => {
    const { result } = dump(true, "alpha\nbeta");
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("DUMP workshop\nFAILED mongodump workshop, exit 7\nmongodump stderr withheld: credential contains a newline\n");
    expect(result.stderr).toBe("");
  });
});
