import { describe, it, expect } from "vitest";
import { builtBundleEngine, bundleReleaseTag, declaredEngine, engineLineRefusal, ENGINE_NOT_CHECKED, newMembersRefusal, repositoryEngine, throwEngineLineRefusal, versionLine } from "./engine-line.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { TenantMemberRecord } from "../../../shared/tenant.ts";

const ENGINE = { build: "example-engine", line: "0.3" };
const APPS = (engine: string): string => `apps:\n  - name: erp\n    title: ERP\n${engine}`;

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
    expect(refusal).toContain("which the Manager does not do");
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
});
