// gate-runner/src/exec.test.ts — the subprocess helper: success, non-zero exit, oversize, timeout.
import { describe, expect, it } from "vitest";
import { ExecError, run } from "./exec.ts";

const node = process.execPath;

describe("exec.run", () => {
  it("returns stdout on a successful run", async () => {
    const r = await run(node, ["-e", "process.stdout.write('hi')"], { timeoutMs: 5000, maxBytes: 1024 });
    expect(r.stdout).toBe("hi");
  });

  it("rejects a non-zero exit as ExecError kind 'exit' with the code", async () => {
    await expect(run(node, ["-e", "process.exit(3)"], { timeoutMs: 5000, maxBytes: 1024 })).rejects.toMatchObject({
      name: "ExecError",
      kind: "exit",
      code: 3,
    });
  });

  it("rejects output over maxBytes as ExecError kind 'oversize'", async () => {
    const p = run(node, ["-e", "process.stdout.write('x'.repeat(100000))"], { timeoutMs: 5000, maxBytes: 100 });
    await expect(p).rejects.toBeInstanceOf(ExecError);
    await expect(p).rejects.toMatchObject({ kind: "oversize" });
  });

  it("rejects a run that exceeds the timeout as ExecError kind 'timeout'", async () => {
    await expect(
      run(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300, maxBytes: 1024 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
