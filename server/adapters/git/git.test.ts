import { describe, it, expect } from "vitest";
import { FakeRepoReader, FakePlatformRepo } from "./testing/fake.ts";
import { computeBackoffMs, type PushBackoff } from "./git.ts";

describe("FakeRepoReader", () => {
  it("clones at a ref (recording the read credential) and serves the scripted files", async () => {
    const r = new FakeRepoReader({
      resolvedSha: "a".repeat(40),
      files: { "deploy/platform.yaml": "kind: ConsumerManifest" },
    });
    const c = await r.cloneAtRef({ repoURL: "https://github.com/x/y.git", ref: "main", credentialId: "cred_1" });
    expect(c.resolvedSha).toBe("a".repeat(40));
    expect(await r.readFile(c.workdir, "deploy/platform.yaml")).toContain("ConsumerManifest");
    // The private-repo read credential is recorded so a test can assert it never left the Controller.
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

// The push-reject backoff schedule is the new pure logic in the git adapter — the
// commitPush retry loop that consumes it shells out to a live git, so the deterministic base delay is
// unit-tested here and the loop is exercised by the higher-level onboarding integration tests.
describe("computeBackoffMs (GitPlatformRepo push-reject backoff)", () => {
  it("is 0 when no backoff is configured (the consumer repo keeps the original no-wait behavior)", () => {
    expect(computeBackoffMs(0, undefined)).toBe(0);
    expect(computeBackoffMs(3, undefined)).toBe(0);
    expect(computeBackoffMs(0, {})).toBe(0);
    expect(computeBackoffMs(2, { retries: 6 })).toBe(0); // retries set, base still 0 ⇒ no wait
  });

  it("is 0 when baseDelayMs is not positive", () => {
    expect(computeBackoffMs(2, { baseDelayMs: 0 })).toBe(0);
    expect(computeBackoffMs(2, { baseDelayMs: -100 })).toBe(0);
  });

  it("grows as baseDelayMs * 2^attempt", () => {
    const opts: PushBackoff = { baseDelayMs: 250 };
    expect(computeBackoffMs(0, opts)).toBe(250);
    expect(computeBackoffMs(1, opts)).toBe(500);
    expect(computeBackoffMs(2, opts)).toBe(1000);
    expect(computeBackoffMs(3, opts)).toBe(2000);
  });

  it("caps the wait at maxDelayMs once the exponential exceeds it", () => {
    const opts: PushBackoff = { baseDelayMs: 250, maxDelayMs: 8_000 };
    expect(computeBackoffMs(5, opts)).toBe(8_000); // 250*32 = 8000, exactly the cap
    expect(computeBackoffMs(6, opts)).toBe(8_000); // 250*64 = 16000, clamped
    expect(computeBackoffMs(20, opts)).toBe(8_000);
  });

  it("is unbounded when maxDelayMs is absent or 0", () => {
    expect(computeBackoffMs(4, { baseDelayMs: 100 })).toBe(1_600);
    expect(computeBackoffMs(4, { baseDelayMs: 100, maxDelayMs: 0 })).toBe(1_600);
  });

  it("degrades gracefully on a huge attempt (2^attempt overflow to Infinity)", () => {
    expect(computeBackoffMs(2000, { baseDelayMs: 250, maxDelayMs: 8_000 })).toBe(8_000);
    // With no cap, an overflowing exponential falls back to the base delay rather than Infinity.
    expect(computeBackoffMs(2000, { baseDelayMs: 250 })).toBe(250);
  });
});
