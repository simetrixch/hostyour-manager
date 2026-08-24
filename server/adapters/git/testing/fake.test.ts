import { describe, it, expect } from "vitest";
import { FakeRepoReader, FakePlatformRepo } from "./fake.ts";

describe("FakeRepoReader", () => {
  it("clones at a ref (recording the read credential) and serves the scripted files", async () => {
    const r = new FakeRepoReader({
      resolvedSha: "a".repeat(40),
      files: { "deploy/platform.yaml": "kind: ConsumerManifest" },
    });
    const c = await r.cloneAtRef({ repoURL: "https://github.com/x/y.git", ref: "main", credentialId: "cred_1" });
    expect(c.resolvedSha).toBe("a".repeat(40));
    expect(await r.readFile(c.workdir, "deploy/platform.yaml")).toContain("ConsumerManifest");
    // The private-repo read credential is recorded so a test can assert it never left the Manager.
    expect(r.clones[0]?.credentialId).toBe("cred_1");
  });

  it("records a public clone with no credential", async () => {
    const r = new FakeRepoReader();
    await r.cloneAtRef({ repoURL: "https://github.com/x/pub.git", ref: "main" });
    expect(r.clones[0]?.credentialId).toBeUndefined();
  });
});

describe("FakePlatformRepo", () => {
  it("commits pointer writes and reads a prior seeded report", async () => {
    const p = new FakePlatformRepo();
    p.seed("s1.example", "consumers/prod/reports/acme/old.json", '{"old":true}');

    const commit = await p.withBranch("s1.example", async (books) => {
      expect(await books.readFile("consumers/prod/reports/acme/old.json")).toContain("old");
      const written = await books.commit({
        message: "onboard(acme): pin abc [run_1]",
        write: [{ path: "consumers/prod/active/acme.yaml", content: "name: acme" }],
      });
      expect(await books.readFile("consumers/prod/active/acme.yaml")).toContain("name: acme");
      return written.commit;
    });

    expect(commit).toMatch(/^commit_/);
    expect(p.commits).toHaveLength(1);
    expect(p.commits[0]?.branch).toBe("s1.example");
  });

  it("removes a pointer on offboard", async () => {
    const p = new FakePlatformRepo();
    await p.withBranch("s1.example", (books) =>
      books.commit({ message: "onboard [run_1]", write: [{ path: "consumers/prod/active/acme.yaml", content: "x" }] }),
    );
    await p.withBranch("s1.example", (books) =>
      books.commit({ message: "offboard(acme) [run_2]", remove: ["consumers/prod/active/acme.yaml"] }),
    );
    expect(p.read("s1.example", "consumers/prod/active/acme.yaml")).toBeNull();
  });

  // The ordering guarantee the port promises, asserted on the fake so every domain test that runs
  // against it inherits a world production can actually produce. Two turns on ONE branch may not
  // interleave; two turns on DIFFERENT branches must not wait for each other, or a slow read of one
  // cluster would stall every other cluster's writes.
  it("runs turns on one branch strictly one after another, and lets two branches overlap", async () => {
    const p = new FakePlatformRepo();
    const order: string[] = [];
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    const slow = p.withBranch("s1.example", async () => {
      order.push("a:start");
      await tick();
      await tick();
      order.push("a:end");
    });
    const queued = p.withBranch("s1.example", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    const other = p.withBranch("s2.example", async () => {
      order.push("other");
    });
    await Promise.all([slow, queued, other]);

    expect(order.slice(0, 2)).toEqual(["a:start", "other"]);
    expect(order.indexOf("b:start")).toBeGreaterThan(order.indexOf("a:end"));
  });

  // A turn that throws must release the branch. Without this the first failed read would wedge every
  // later turn on that branch for the life of the process — a worse outcome than the race itself.
  it("releases the branch when a turn throws", async () => {
    const p = new FakePlatformRepo();
    await expect(p.withBranch("s1.example", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(p.withBranch("s1.example", async (books) => books.branch)).resolves.toBe("s1.example");
  });
});
