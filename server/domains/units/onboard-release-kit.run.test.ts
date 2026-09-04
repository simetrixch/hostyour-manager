import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { openDb, type DbHandle } from "../../db/client.ts";
import { injectReleaseKitStep, removeReleaseKit } from "./onboard-release-kit.ts";
import { DeployableOnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { RELEASE_KIT_FILES, RELEASE_KIT_PATHS, RELEASE_KIT_REMOVE_PATHS } from "./release-kit/release-kit.ts";
import { FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { AppError } from "../../kernel/errors.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// Focused tests for the onboard `inject-release-kit` step + the shared offboard/purge removal helper
// (impl: onboard-release-kit.ts). Kept apart from onboard.run.test.ts so each file stays within the
// per-file line budget (the onboard-webhook pattern). The step is built in isolation
// (injectReleaseKitStep) — it only touches ports.consumerRepo + the sealed PAT, never the kube/vault
// clients, so the harness stays tiny.
//
// The load-bearing property: the kit is REPLACED, never layered over — a divergent copy is
// overwritten to the current asset bytes, a stale file of an older kit is removed in the same
// commit, and an onboarding over an old kit leaves the repo byte-identical to a fresh one.
const SHA = "a".repeat(40);
const REPO_URL = "https://github.com/x/acme.git";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function params(over: Partial<DeployableOnboardParams> = {}): DeployableOnboardParams {
  return DeployableOnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: REPO_URL, owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    report: { contractVersion: "1.5", runnerVersion: "t", repoURL: REPO_URL, requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  });
}

/** Build the step in isolation with only the consumer-repo writer port present (the rest are never
 *  read). A "no writer wired" case OMITS the key (exactOptionalPropertyTypes forbids explicit undefined). */
function step(ports: Record<string, unknown>): Step {
  return injectReleaseKitStep(ports as unknown as OnboardPorts, params());
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_onb", stepName: "inject-release-kit", db: db.db, creds: {} as unknown as CredentialStore, params: params(),
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("onboard inject-release-kit step (replace, never layer)", () => {
  it("commits the 3 release-kit files on the consumer repo's default branch when none are present", async () => {
    const consumerRepo = new FakeConsumerRepo({ branch: "trunk" }); // a non-main default proves branch resolution rides through
    const logs: string[] = [];
    await step({ consumerRepo }).run(ctx(logs));

    // Opened the CONSUMER repo with the sealed one-PAT-per-consumer (the adapter opens it, never a raw token).
    expect(consumerRepo.opened).toEqual([{ repoURL: REPO_URL, credentialId: "cred_pat" }]);
    // Exactly ONE commit, on the resolved default branch, writing all three target paths and removing nothing.
    expect(consumerRepo.commits).toHaveLength(1);
    const c = consumerRepo.commits[0]!;
    expect(c.branch).toBe("trunk");
    expect(c.remove).toEqual([]);
    expect(c.write?.map((w) => w.path)).toEqual(["release/release.ps1", "release/release.sh", ".github/workflows/release.yml"]);
    // The bytes are the embedded assets, verbatim.
    const byPath = Object.fromEntries((c.write ?? []).map((w) => [w.path, w.content]));
    for (const f of RELEASE_KIT_FILES) expect(byPath[f.path]).toBe(f.content);
    expect(Object.keys(consumerRepo.filesFor(REPO_URL)).sort()).toEqual([...RELEASE_KIT_PATHS].sort());
    expect(logs.some((l) => l.includes("wrote 3 file(s)"))).toBe(true);
  });

  it("is a NO-OP on a repo already carrying the current kit: no commit, no error", async () => {
    const consumerRepo = new FakeConsumerRepo();
    for (const f of RELEASE_KIT_FILES) consumerRepo.seed(REPO_URL, f.path, f.content); // present + current
    const logs: string[] = [];
    await step({ consumerRepo }).run(ctx(logs)); // resolves — a re-onboard is legitimate

    expect(consumerRepo.commits).toHaveLength(0); // nothing differs → commitPush never called
    expect(logs.some((l) => l.includes("already carry the current kit"))).toBe(true);
  });

  it("puts the release logic back into THIS repository's release/ — the manager is a registered consumer of itself nowhere", async () => {
    // The kit REPLACES, and it replaces a file that only STARTS the asset like any other: the
    // onboarding triggers the script it just wrote, so a copy nobody validated must not survive it.
    // This repository's own two files under release/ are start scripts, so an onboarding of this
    // repository over its own repo URL writes the full assets over them, and the copy
    // release-kit.test.ts refuses stands in this repository until somebody puts the start scripts
    // back by hand. NOTHING IN THE CODE REFUSES THAT: what keeps it from happening is that no
    // registration names this repository as a consumer. This test states the outcome so that the
    // replace is not read as a guarantee that the two start scripts survive it.
    //
    // Seeded with the bytes that actually stand in this repository — read off disk, not off the
    // assets — so the assertion measures the two copies rather than restating one.
    const consumerRepo = new FakeConsumerRepo();
    const own: Record<string, string> = {};
    for (const path of ["release/release.sh", "release/release.ps1"]) {
      own[path] = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
      consumerRepo.seed(REPO_URL, path, own[path]!);
    }
    const logs: string[] = [];
    await step({ consumerRepo }).run(ctx(logs));

    // Both files differ from the asset, so the replace writes all three paths. Nothing is REMOVED:
    // everything standing under release/ is kit-owned.
    expect(consumerRepo.commits[0]?.write?.map((w) => w.path) ?? []).toEqual([...RELEASE_KIT_PATHS]);
    expect(consumerRepo.commits[0]?.remove).toEqual([]);

    // What is traded: the two files carry none of the release logic, and the asset that lands in
    // their place carries all of it. The manifest stamp, the build wait and the pin write are the
    // three a release of this repository cannot do without, so each one is named rather than
    // counted.
    const files = consumerRepo.filesFor(REPO_URL);
    for (const marker of ["stamp_manifest_version", "gh run watch", 'git -C "$PLATFORM_REPO_DIR" push --quiet origin "$branch"']) {
      expect(own["release/release.sh"]).not.toContain(marker);
      expect(files["release/release.sh"]).toContain(marker);
    }
    for (const marker of ["Set-ManifestVersion", "gh run watch", "git -C $platformRepoDir push --quiet origin $Branch"]) {
      expect(own["release/release.ps1"]).not.toContain(marker);
      expect(files["release/release.ps1"]).toContain(marker);
    }
  });

  it("REPLACES a divergent copy with the current asset bytes — the kit is platform-owned, and the trigger runs exactly these bytes", async () => {
    const consumerRepo = new FakeConsumerRepo();
    for (const f of RELEASE_KIT_FILES) consumerRepo.seed(REPO_URL, f.path, f.content);
    consumerRepo.seed(REPO_URL, ".github/workflows/release.yml", "name: OldKitRelease\n"); // an older kit's workflow
    const logs: string[] = [];
    await step({ consumerRepo }).run(ctx(logs));

    expect(consumerRepo.commits).toHaveLength(1);
    expect(consumerRepo.commits[0]!.write?.map((w) => w.path)).toEqual([".github/workflows/release.yml"]);
    // Byte-identical to a fresh onboarding afterwards.
    const workflow = RELEASE_KIT_FILES.find((f) => f.path === ".github/workflows/release.yml")!;
    expect(consumerRepo.filesFor(REPO_URL)[".github/workflows/release.yml"]).toBe(workflow.content);
    expect(logs.some((l) => l.includes("differs from the current kit") && l.includes("replacing it"))).toBe(true);
  });

  it("REMOVES a stale file of an older kit under release/ in the same commit; consumer-owned paths are untouched", async () => {
    const consumerRepo = new FakeConsumerRepo();
    for (const f of RELEASE_KIT_FILES) consumerRepo.seed(REPO_URL, f.path, f.content);
    consumerRepo.seed(REPO_URL, "release/release-legacy.sh", "old kit helper\n"); // stale — the current set no longer carries it
    consumerRepo.seed(REPO_URL, "src/app.ts", "consumer code\n"); // consumer-owned — never touched
    const logs: string[] = [];
    await step({ consumerRepo }).run(ctx(logs));

    expect(consumerRepo.commits).toHaveLength(1);
    expect(consumerRepo.commits[0]!.write).toEqual([]);
    expect(consumerRepo.commits[0]!.remove).toEqual(["release/release-legacy.sh"]);
    const files = consumerRepo.filesFor(REPO_URL);
    expect(files["release/release-legacy.sh"]).toBeUndefined();
    expect(files["src/app.ts"]).toBe("consumer code\n");
    expect(logs.some((l) => l.includes("removed 1 stale file(s)"))).toBe(true);
  });

  it("fails CLOSED when the push is unauthorized (a PAT without contents:write)", async () => {
    const consumerRepo = new FakeConsumerRepo();
    consumerRepo.failCommit(new AppError("UPSTREAM", "git push failed: remote: Permission to x/acme.git denied to token (403)"));
    // The step throws, so the run aborts before the release cycle is ever triggered.
    await expect(step({ consumerRepo }).run(ctx([]))).rejects.toThrow(/Permission to x\/acme\.git denied/);
  });

  it("fails LOUD when no consumer-repo writer is wired (no release kit → no release cycle)", async () => {
    // The consumerRepo key is OMITTED — the unwired-writer case.
    await expect(step({}).run(ctx([]))).rejects.toThrow(/requires the consumer-repo git writer but none is wired/);
  });
});

describe("removeReleaseKit (shared offboard/purge teardown)", () => {
  it("git-rm's the kit directory + the workflow file and is fail-soft on a push refusal", async () => {
    const consumerRepo = new FakeConsumerRepo();
    for (const p of RELEASE_KIT_PATHS) consumerRepo.seed(REPO_URL, p, "kit"); // present from onboard
    consumerRepo.seed(REPO_URL, "release/release-legacy.sh", "old kit helper\n"); // a stale leftover goes with the directory
    const logs: string[] = [];
    await removeReleaseKit(ctx(logs), { consumerRepo, consumerName: "acme", repoURL: REPO_URL, repoCredentialId: "cred_pat" });
    expect(consumerRepo.commits).toHaveLength(1);
    expect(consumerRepo.commits[0]!.remove).toEqual([...RELEASE_KIT_REMOVE_PATHS]);
    expect(Object.keys(consumerRepo.filesFor(REPO_URL)).filter((p) => p.startsWith("release/"))).toEqual([]);
    expect(logs.some((l) => l.includes("release-kit removed from"))).toBe(true);

    // Fail-soft: a push refusal logs + returns, never throws.
    const failing = new FakeConsumerRepo();
    failing.failCommit(new AppError("UPSTREAM", "git push failed: 403"));
    const warnLogs: string[] = [];
    await expect(removeReleaseKit(ctx(warnLogs), { consumerRepo: failing, consumerName: "acme", repoURL: REPO_URL, repoCredentialId: "cred_pat" })).resolves.toBeUndefined();
    expect(warnLogs.some((l) => l.includes("release-kit NOT removed") && l.includes("by hand"))).toBe(true);
  });

  it("fail-soft SKIPS when the writer is unwired or the repo URL / sealed PAT is unknown (a purge orphan)", async () => {
    const noWriterLogs: string[] = [];
    await removeReleaseKit(ctx(noWriterLogs), { consumerRepo: undefined, consumerName: "acme", repoURL: REPO_URL, repoCredentialId: "cred_pat" });
    expect(noWriterLogs.some((l) => l.includes("no consumer-repo git writer is wired"))).toBe(true);

    const consumerRepo = new FakeConsumerRepo();
    const orphanLogs: string[] = [];
    await removeReleaseKit(ctx(orphanLogs), { consumerRepo, consumerName: "acme", repoURL: null, repoCredentialId: null });
    expect(consumerRepo.opened).toEqual([]); // never opened — nothing to remove
    expect(orphanLogs.some((l) => l.includes("release-kit removal skipped") && l.includes("no inventory row"))).toBe(true);
  });
});
