import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";

// The wizard's prefill: the version the repository states, read once with a PAT that does not
// outlive the read. Three sources in order — package.json, the chart's appVersion, the default —
// and the credential row is gone afterwards whatever the read answered.

let db: DbHandle;
let store: CredentialStore;
beforeEach(() => {
  db = openDb(":memory:");
  store = new CredentialStore({ db: db.db, logger: pino({ level: "silent" }) });
});
afterEach(() => { db.sqlite.close(); });

const REPO = "https://github.com/x/acme.git";
const request = (over: Partial<OnboardPrefillRequest> = {}): OnboardPrefillRequest => OnboardPrefillRequest.parse({ repoURL: REPO, repoPat: "github_pat_test", ...over });
const signal = (): AbortSignal => new AbortController().signal;

describe("readOnboardPrefill", () => {
  it("answers package.json's version first, naming the source", async () => {
    const repo = new FakeRepoReader({ files: { "package.json": '{"name":"acme","version":"1.4.0"}', "deploy/chart/Chart.yaml": "apiVersion: v2\nname: acme\nversion: 0.1.0\nappVersion: 9.9.9\n" } });
    const view = await readOnboardPrefill({ repo, store }, request(), signal());
    expect(view).toEqual({ version: "1.4.0", versionSource: "package.json version", channel: "stable", channelSource: "default" });
  });

  it("falls back to the chart's appVersion at the request's chart path, then to 0.1.0 — each naming its source", async () => {
    const chart = new FakeRepoReader({ files: { "charts/app/Chart.yaml": "apiVersion: v2\nname: acme\nversion: 0.1.0\nappVersion: 2.0.0\n" } });
    expect(await readOnboardPrefill({ repo: chart, store }, request({ chartPath: "charts/app" }), signal())).toMatchObject({ version: "2.0.0", versionSource: "charts/app/Chart.yaml appVersion" });
    const bare = new FakeRepoReader({ files: {} });
    const view = await readOnboardPrefill({ repo: bare, store }, request(), signal());
    expect(view.version).toBe("0.1.0");
    expect(view.versionSource).toContain("default");
    expect(view.versionSource).toContain("deploy/chart/Chart.yaml");
  });

  it("passes over a version outside the release grammar instead of offering a number the run would refuse", async () => {
    const repo = new FakeRepoReader({ files: { "package.json": '{"version":"1.4.0-beta.1"}', "deploy/chart/Chart.yaml": "appVersion: 01.2.3\n" } });
    expect((await readOnboardPrefill({ repo, store }, request(), signal())).version).toBe("0.1.0");
  });

  it("seals the PAT for the one clone and purges it again — no credential row outlives the read", async () => {
    const repo = new FakeRepoReader({ files: { "package.json": '{"version":"1.0.0"}' } });
    await readOnboardPrefill({ repo, store }, request(), signal());
    expect(repo.clones).toHaveLength(1);
    expect(repo.clones[0]?.credentialId).toMatch(/^cred_/);
    expect(await store.list({ kind: "pat" })).toEqual([]);
    await expect(store.open(repo.clones[0]!.credentialId!, { purpose: "onboard-prefill:test" })).rejects.toThrow(/not found/);
  });

  it("purges the PAT even when the clone fails", async () => {
    const repo = new FakeRepoReader({});
    repo.cloneAtRef = () => Promise.reject(new Error("authentication required"));
    await expect(readOnboardPrefill({ repo, store }, request(), signal())).rejects.toThrow(/authentication required/);
    expect(await store.list({ kind: "pat" })).toEqual([]);
  });
});

describe("OnboardPrefillRequest", () => {
  it("takes a .git https URL, a non-empty PAT and a relative chart path defaulting to deploy/chart", () => {
    expect(request().chartPath).toBe("deploy/chart");
    expect(OnboardPrefillRequest.safeParse({ repoURL: "git@github.com:x/acme.git", repoPat: "p" }).success).toBe(false);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO, repoPat: "" }).success).toBe(false);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO, repoPat: "p", chartPath: "/etc" }).success).toBe(false);
  });
});
