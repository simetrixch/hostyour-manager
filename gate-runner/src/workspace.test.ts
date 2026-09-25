import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspace } from "./workspace.ts";

const made: string[] = [];
async function ws(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gr-ws-"));
  made.push(d);
  return d;
}
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe("readWorkspace", () => {
  it("reads regular files as a repo-relative UTF-8 map, recursing into subdirs", async () => {
    const dir = await ws();
    await writeFile(join(dir, "platform.yaml"), "name: acme\n");
    await mkdir(join(dir, "deploy", "chart"), { recursive: true });
    await writeFile(join(dir, "deploy", "chart", "Chart.yaml"), "name: acme\n");
    const files = await readWorkspace(dir);
    expect(files.get("platform.yaml")).toBe("name: acme\n");
    expect(files.get("deploy/chart/Chart.yaml")).toBe("name: acme\n");
    expect(files.size).toBe(2);
  });

  it("EXCLUDES the .git directory (git internals are not repo content)", async () => {
    const dir = await ws();
    await writeFile(join(dir, "keep.txt"), "x");
    await mkdir(join(dir, ".git", "refs"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(dir, ".git", "refs", "x"), "deadbeef");
    const files = await readWorkspace(dir);
    expect([...files.keys()]).toEqual(["keep.txt"]);
  });

  it("omits binary / non-UTF-8 files (attested-but-omitted, same rule as the bundle path)", async () => {
    const dir = await ws();
    await writeFile(join(dir, "text.txt"), "hello");
    await writeFile(join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const files = await readWorkspace(dir);
    expect(files.has("text.txt")).toBe(true);
    expect(files.has("bin.dat")).toBe(false);
  });

  it("fails closed on a symlink that escapes the workspace", async () => {
    const dir = await ws();
    const outside = await ws();
    await writeFile(join(outside, "secret"), "s");
    try {
      await symlink(join(outside, "secret"), join(dir, "link"));
    } catch {
      return; // symlink creation may be denied on some CI (Windows w/o privilege) — skip, not a failure
    }
    await expect(readWorkspace(dir)).rejects.toThrow(/escapes the workspace/);
  });
});
