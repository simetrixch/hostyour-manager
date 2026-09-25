import { describe, it, expect } from "vitest";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";
import type { OwnerIdentityReader } from "./repo-identity.ts";

// The wizard's prefill: the version the onboarding will release, read off the release tags — the
// next number, never the last one — and the repositories it was read over named in the source. The
// identity that reads is the owner's (#220): nothing rides the request but the URL.

const REPO = "https://github.com/x/acme.git";
const request = (over: Partial<OnboardPrefillRequest> = {}): OnboardPrefillRequest => OnboardPrefillRequest.parse({ repoURL: REPO, ...over });
const signal = (): AbortSignal => new AbortController().signal;

/** An owner record: every owner named reads packages; `withPat` owners hold a repository PAT too. */
function owners(owners: string[], withPat: string[] = []): OwnerIdentityReader {
  return (org) => (owners.includes(org) ? { packagesCredentialId: `cred_pkg_${org}`, repoCredentialId: withPat.includes(org) ? `cred_pat_${org}` : null } : null);
}
/** A store that opens an owner's repository PAT to a token named after it, and lists one recorded
 *  packages reader row per owner the reader names (fingerprint after the owner). */
const store = {
  open: async (id: string) => Buffer.from(`token-of-${id}`, "utf8"),
  list: async (filter?: { subject?: { kind: string; id: string } }) =>
    (filter?.subject ? [{ id: `cred_pkg_${filter.subject.id}`, fingerprint: `sha256:pkg-${filter.subject.id}`, recordedAt: "2026-09-21T00:00:00.000Z" }] : []) as never,
};

describe("readOnboardPrefill", () => {
  it("answers the next number after the repository's release tags, naming the repository", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", ["0.1.0-stable-20260909094733", "0.1.2-stable-20260909121415", "0.1.1-beta-20260909114034", "v9"]);
    const view = await readOnboardPrefill({ github, owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(view).toEqual({ version: "0.1.3", versionSource: "the next number after the release tags of x/acme", channel: "stable", channelSource: "default", identity: "pat" });
    expect(github.tagReads).toEqual([{ owner: "x", repo: "acme" }]);
  });

  it("starts a repository with no release tag at 0.1.0", async () => {
    const view = await readOnboardPrefill({ github: new FakeGitHubConsumer(), owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(view.version).toBe("0.1.0");
  });

  it("reads a platform-line unit over the platform's line: its own repo, the platform repo and the engine's", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("simetrixch", "hostyour-manager", ["0.8.169-stable-20260913211928"]);
    github.seedTags("simetrixch", "hostyour-cloud", ["0.8.170-stable-20260914032934"]);
    github.seedTags("simetrixch", "ansiwise-cli", ["0.8.165-stable-20260911210935"]);
    const platformRepo = { withBranch: async (_b: string, fn: (t: { readFile: (p: string) => Promise<string | null> }) => Promise<string | null>) => fn({ readFile: async () => "cliTools:\n  ansiwise:\n    version: 0.8.165-stable-20260911210935\n    upstream: { kind: github_release, project: simetrixch/ansiwise-cli }\n" }) };
    const view = await readOnboardPrefill(
      { github, platformGitHub: { owner: "simetrixch", repo: "hostyour-cloud" }, platformRepo: platformRepo as never, owners: owners(["simetrixch"], ["simetrixch"]), store },
      request({ repoURL: "https://github.com/simetrixch/hostyour-manager.git" }),
      signal(),
    );
    expect(view.version).toBe("0.8.171");
    expect(view.versionSource).toBe("the next number after the release tags of simetrixch/hostyour-manager, simetrixch/hostyour-cloud, simetrixch/ansiwise-cli");
  });

  it("reads a customer's unit over its own tags only, whatever the platform's line holds", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", ["1.4.0-stable-20260909094733"]);
    github.seedTags("simetrixch", "hostyour-cloud", ["0.8.170-stable-20260914032934"]);
    const view = await readOnboardPrefill({ github, platformGitHub: { owner: "simetrixch", repo: "hostyour-cloud" }, owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(view.version).toBe("1.4.1");
    expect(github.tagReads).toEqual([{ owner: "x", repo: "acme" }]);
  });
});

// THE RULE (#220): the owner's identity by the owner of the URL — the App where its
// installation reaches the repository, else the owner's repository PAT, else a refusal; and
// the owner's packages reader is required whichever reads.
describe("readOnboardPrefill — which identity reads the repository", () => {
  it("reads a repository the App reaches with the App's token, and names the identity", async () => {
    const github = new FakeGitHubConsumer();
    const githubApp = new FakeGitHubApp();
    github.seedTags(githubApp.org, "acme", ["0.2.0-stable-20260909094733"]);
    const view = await readOnboardPrefill({ github, githubApp, owners: owners([githubApp.org]), store }, request({ repoURL: `https://github.com/${githubApp.org}/acme.git` }), signal());
    expect(view.identity).toBe("github-app");
    expect(view.version).toBe("0.2.1");
    expect(github.tokensSeen).toEqual([githubApp.token]);
  });

  it("reads a repository outside the installation with the owner's repository PAT — the external consumer", async () => {
    const github = new FakeGitHubConsumer();
    const view = await readOnboardPrefill({ github, githubApp: new FakeGitHubApp(), owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(view.identity).toBe("pat");
    expect(github.tokensSeen).toEqual(["token-of-cred_pat_x"]);
  });

  // THE REPOSITORY PAT IS ASKED FOR WHERE THE APP DOES NOT REACH (#238): the prefill answers no
  // identity and names the owner; nothing is read until the wizard records the PAT.
  it("answers no identity for a repository outside the installation whose owner records no repository PAT, naming the owner and why", async () => {
    const github = new FakeGitHubConsumer();
    const view = await readOnboardPrefill({ github, githubApp: new FakeGitHubApp(), owners: owners(["x"]), store }, request(), signal());
    expect(view).toMatchObject({ identity: "none", version: null, repositoryPat: { owner: "x", recorded: null } });
    expect(view.versionSource).toContain("installed in the owner example-org and does not reach x/acme");
    expect(view.versionSource).toContain("consumer wizard");
    expect(github.tagReads).toEqual([]);
  });


  it("says so for a repository on a manager with no App and no repository PAT", async () => {
    const view = await readOnboardPrefill({ github: new FakeGitHubConsumer(), owners: owners(["x"]), store }, request(), signal());
    expect(view.identity).toBe("none");
    expect(view.versionSource).toContain("is not configured on this manager");
  });
});

// THE PACKAGES READER IS ASKED FOR WHERE IT IS NEEDED (#237): the `.npmrc` read through the API says
// which scopes the build installs privately; the owner's recorded reader says whether the wizard asks.
describe("readOnboardPrefill — the owner's packages reader", () => {
  it("names the reader the build needs — recorded where the owner records one, to be asked where none, absent where no scope is routed", async () => {
    const github = new FakeGitHubConsumer();
    github.seedFile("x", "acme", ".npmrc", "@x:registry=https://npm.pkg.github.com\n@shared:registry=https://npm.pkg.github.com\n");
    const recorded = await readOnboardPrefill({ github, owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(recorded.packagesReader).toEqual({ owner: "x", scopes: ["x", "shared"], recorded: { fingerprint: "sha256:pkg-x", recordedAt: "2026-09-21T00:00:00.000Z" } });
    const asked = await readOnboardPrefill({ github, owners: (org) => (org === "x" ? { packagesCredentialId: null, repoCredentialId: "cred_pat_x" } : null), store }, request(), signal());
    expect(asked.packagesReader).toEqual({ owner: "x", scopes: ["x", "shared"], recorded: null });
    const none = await readOnboardPrefill({ github: new FakeGitHubConsumer(), owners: owners(["x"], ["x"]), store }, request(), signal());
    expect(none.packagesReader).toBeUndefined();
  });
});

describe("OnboardPrefillRequest", () => {
  it("takes a .git https URL and nothing else", () => {
    expect(OnboardPrefillRequest.safeParse({ repoURL: "git@github.com:x/acme.git" }).success).toBe(false);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO }).success).toBe(true);
    expect(OnboardPrefillRequest.parse({ repoURL: REPO, repoPat: "p" })).toEqual({ repoURL: REPO }); // a stray PAT is dropped, never read
  });
});
