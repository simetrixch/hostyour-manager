import { describe, it, expect } from "vitest";
import { builtBundleEngine, bundleReleaseRefusal, bundleReleaseTag, declaredEngine, engineLineRefusal, ENGINE_NOT_CHECKED, movesLine, repositoryEngine, standingAppNeeds, throwEngineLineRefusal, versionLine } from "./engine-line.ts";
import { newMembersRefusal } from "./tenant-versions.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { TenantMemberRecord, TenantRegistration } from "../../../shared/tenant.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";

const ENGINE = { build: "example-engine", line: "0.3" };
const APPS = (engine: string): string => `apps:\n  - name: erp\n    title: ERP\n${engine}`;
const ON_03 = "0.3.004-stable-20260928080242-a1b2c3d";
const ON_03_NEXT = "0.3.005-stable-20260929080242-b2c3d4e";
const ON_04 = "0.4.000-stable-20261001000000-abc1234";
const BUNDLE_REPO = "https://github.com/acme-org/example-apps-acme.git";
const BUNDLE_TAG = "0.3.002-stable-20260927000000-1234abc";
/** A reader that fails every clone, the way a renamed repository or a withdrawn App answers. */
const unreadable = { repo: { cloneAtRef: async (): Promise<never> => { throw new Error("git fetch failed: repository not found"); }, readFile: async () => null, dispose: async () => undefined } };

describe("the engine line a bundle is written for", () => {
  it("reads a tag's line as its first two numbers", () => {
    expect(versionLine("0.3.005-stable-20260928072937-1915d2f")).toBe("0.3");
    expect(versionLine("0.10.1-beta-20260101000000-abc1234")).toBe("0.10");
  });

  it("passes members on the bundle's line, and members that run no engine at all", () => {
    expect(engineLineRefusal(ENGINE, { erp: { "example-engine": "0.3.004-stable-20260928080242-a1b2c3d" }, auth: { "example-auth": "0.4.000-stable-20260101000000-abc1234" } })).toBeNull();
  });

  it("PLANTED DEFECT: refuses a member whose engine is of another line, naming it and both lines", () => {
    const refusal = engineLineRefusal(ENGINE, {
      erp: { "example-engine": "0.3.004-stable-20260928080242-a1b2c3d" },
      web: { "example-engine": "0.4.000-stable-20261001000000-abc1234" },
    });
    expect(refusal).toContain("written for example-engine 0.3");
    expect(refusal).toContain("web would run example-engine 0.4.000-stable-20261001000000-abc1234");
    expect(refusal).not.toContain("erp would run");
    expect(refusal).toContain(`through "Move to line" in its Versions dialog (the run tenant-line-move)`);
  });

  it("judges nothing for a bundle that declares no engine", () => {
    expect(engineLineRefusal(undefined, { erp: { "example-engine": "0.4.000-stable-20261001000000-abc1234" } })).toBeNull();
  });

  it("reads the engine an apps.yaml declares, and none where it declares none or is missing", () => {
    expect(declaredEngine(APPS('engine:\n  build: example-engine\n  line: "0.3"\n'))).toEqual(ENGINE);
    expect(declaredEngine(APPS(""))).toBeUndefined();
    expect(declaredEngine(null)).toBeUndefined();
  });

  it("refuses a line YAML reads as a number, since 0.10 would read 0.1", () => {
    expect(() => declaredEngine(APPS("engine:\n  build: example-engine\n  line: 0.3\n"))).toThrow(/engine/);
  });

  it("names the release a bundle's image tag was built from", () => {
    expect(bundleReleaseTag("0.3.005-stable-20260928072937-1915d2f")).toBe("0.3.005-stable-20260928072937");
  });

  it("reads a tenant repository's engine at a ref with the catalog's credential, and says so where it declares none", async () => {
    const logs: string[] = [];
    const ctx = { log: (l: string) => logs.push(l), signal: new AbortController().signal };
    const repo = new FakeRepoReader({ resolvedSha: "a".repeat(40), files: {} });
    repo.scriptFor("https://github.com/x/with.git", { resolvedSha: "a".repeat(40), files: { "apps.yaml": APPS('engine:\n  build: example-engine\n  line: "0.3"\n') } });
    repo.scriptFor("https://github.com/x/without.git", { resolvedSha: "a".repeat(40), files: { "apps.yaml": APPS("") } });
    const ports = { repo, deployCredentialId: "deploy-read-pat" };
    expect(await repositoryEngine(ports, { repoURL: "https://github.com/x/with.git", ref: "0.3.001-stable-20260928000000" }, ctx)).toEqual(ENGINE);
    expect(repo.clones[0]).toEqual({ repoURL: "https://github.com/x/with.git", ref: "0.3.001-stable-20260928000000", credentialId: "deploy-read-pat" });
    expect(await repositoryEngine(ports, { repoURL: "https://github.com/x/without.git", ref: "HEAD" }, ctx)).toBeUndefined();
    expect(logs).toEqual([`https://github.com/x/without.git at HEAD: ${ENGINE_NOT_CHECKED}`]);
    // The bundle a run builds: the standing repository at its head, the catalog where none stands.
    expect(await builtBundleEngine(ports, "https://github.com/x/with.git", undefined, ctx)).toEqual(ENGINE);
    expect(repo.clones.at(-1)?.ref).toBe("HEAD");
    expect(await builtBundleEngine(ports, undefined, ENGINE, ctx)).toEqual(ENGINE);
    expect(await builtBundleEngine(ports, undefined, undefined, ctx)).toBeUndefined();
    expect(logs.at(-1)).toBe(ENGINE_NOT_CHECKED);
  });

  it("judges new members at their stage pins beside the versions the others hold", async () => {
    const member = { name: "crm", sources: [{ chart: "charts/example-engine", valueFiles: [], values: {} }] } as unknown as TenantMemberRecord;
    const pinned = async (): Promise<{ name: string; tag: string }[]> => [{ name: "example-engine", tag: "0.4.000-stable-20261001000000-abc1234" }];
    const refusal = await newMembersRefusal({ engine: ENGINE, held: { erp: { "example-engine": "0.3.004-stable-20260928080242-a1b2c3d" } }, newMembers: [member], pinned });
    expect(refusal).toContain("crm would run example-engine 0.4.000-stable-20261001000000-abc1234");
    expect(refusal).not.toContain("erp would run");
    expect(await newMembersRefusal({ engine: undefined, held: {}, newMembers: [member], pinned })).toBeNull();
    expect(() => throwEngineLineRefusal(refusal, "app \"crm\" cannot be added")).toThrow(/app "crm" cannot be added: the apps bundle is written for/);
    expect(() => throwEngineLineRefusal(null, "nothing")).not.toThrow();
  });

  it("moves a line only where a version changes its line or is one the tenant held none of", () => {
    expect(movesLine({ erp: { "example-engine": ON_03 } }, { erp: { "example-engine": ON_03_NEXT } })).toBe(false);
    expect(movesLine({ erp: { "example-engine": ON_03 } }, { erp: { "example-engine": ON_04 } })).toBe(true);
    expect(movesLine({ erp: { "example-engine": ON_03 } }, { erp: { "example-engine": ON_03 }, crm: { "example-engine": ON_03 } })).toBe(true);
    expect(movesLine({}, {})).toBe(false);
  });

  it("reads the bundle release only where a version moves a line, so a run within its lines needs no repository", async () => {
    const ctx = { log: () => undefined, signal: new AbortController().signal };
    const held = { erp: { "example-engine": ON_03 } };
    const bundle = { appsRepo: BUNDLE_REPO, appsImageTag: BUNDLE_TAG };
    expect(await bundleReleaseRefusal(unreadable, bundle, held, { erp: { "example-engine": ON_03_NEXT } }, ctx)).toBeNull();
    expect(await bundleReleaseRefusal(unreadable, {}, held, { erp: { "example-engine": ON_04 } }, ctx)).toBeNull();
    const repo = new FakeRepoReader({ files: {} });
    repo.scriptFor(BUNDLE_REPO, { files: { "apps.yaml": APPS('engine:\n  build: example-engine\n  line: "0.3"\n') } });
    expect(await bundleReleaseRefusal({ repo }, bundle, held, { erp: { "example-engine": ON_04 } }, ctx)).toContain(`erp would run example-engine ${ON_04}, of another line`);
    expect(repo.clones).toEqual([{ repoURL: BUNDLE_REPO, ref: "0.3.002-stable-20260927000000" }]);
  });

  it("PLANTED DEFECT: names the repository and the release where the bundle cannot be read, instead of the reader's bare error", async () => {
    const ctx = { log: () => undefined, signal: new AbortController().signal };
    await expect(bundleReleaseRefusal(unreadable, { appsRepo: BUNDLE_REPO, appsImageTag: BUNDLE_TAG }, {}, { erp: { "example-engine": ON_04 } }, ctx))
      .rejects.toThrow(`${BUNDLE_REPO} could not be read at 0.3.002-stable-20260927000000, so the engine the apps bundle there is written for cannot be judged: git fetch failed: repository not found`);
  });

  it("refuses a bundle whose registration names no image tag, before any read", async () => {
    const ctx = { log: () => undefined, signal: new AbortController().signal };
    expect(await bundleReleaseRefusal(unreadable, { appsRepo: BUNDLE_REPO, appsImageTag: "0.0.0-placeholder" }, {}, { erp: { "example-engine": ON_04 } }, ctx))
      .toContain('the apps bundle stands at "0.0.0-placeholder", which is no image tag');
  });
});

describe("the needs of a standing tenant's apps, as its own repository declares them", () => {
  const app = (name: string, needs: string[]): TenantRegistration["apps"][number] => ({ name, seedReference: false, seedDemo: false, selections: {}, needs, path: `/app/${name}` });
  const entry = (appsRepo: string): Pick<TenantRegistration, "apps" | "appsRepo" | "appsImageTag"> => ({ apps: [app("erp", ["held"]), app("workshop", [])], appsRepo, appsImageTag: BUNDLE_TAG });
  const own: AppsManifest = { apps: [
    { name: "erp", title: "ERP", description: "", selections: {}, needs: ["report"] },
    { name: "workshop", title: "Workshop", description: "", selections: {}, needs: ["report", "jobs"] },
  ] };
  const unreadableRepo = async (): Promise<never> => { throw new Error(`${BUNDLE_REPO} could not be read at ${BUNDLE_TAG}`); };

  it("reads each app's needs off the tenant's own repository, also for an app the template never offered", async () => {
    const logs: string[] = [];
    expect(await standingAppNeeds(async () => own, entry(BUNDLE_REPO), { log: (l) => logs.push(l), signal: new AbortController().signal })).toEqual({ erp: ["report"], workshop: ["report", "jobs"] });
    expect(logs).toEqual([]);
  });

  it("PLANTED DEFECT: keeps the registration's needs and says why where the repository cannot be read or there is no bundle", async () => {
    const logs: string[] = [];
    const ctx = { log: (l: string) => logs.push(l), signal: new AbortController().signal };
    expect(await standingAppNeeds(unreadableRepo, entry(BUNDLE_REPO), ctx)).toEqual({ erp: ["held"], workshop: [] });
    expect(logs[0]).toMatch(/could not be read at .*; the apps' needs stay as the registration holds them$/);
    expect(await standingAppNeeds(async () => null, entry(""), ctx)).toEqual({ erp: ["held"], workshop: [] });
    expect(logs[1]).toBe("the tenant runs no apps bundle; the apps' needs stay as the registration holds them");
  });
});
