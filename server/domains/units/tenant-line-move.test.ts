import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { testMembers, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { isNewerLine, readLineMove, type LineMovePorts } from "./tenant-line-move.ts";
import type { Approvals } from "./tenant-versions.ts";

// The pairing a move to a newer line writes, read against a bundle repository whose releases carry
// their own apps.yaml and against the engine chart's pin history at prod. The platform unit releases
// two builds together, so a move takes both to one tag.

const REPO = "https://github.com/acme-org/example-apps-acme.git";
const B03 = "0.3.002-stable-20260927000000";
const B04 = "0.4.000-stable-20261010120000";
const SHA03 = "a".repeat(40);
const SHA04 = "b".repeat(40);
const P03 = "0.3.009-stable-20261001000000-1111111";
const P04_OLD = "0.4.000-stable-20261009000000-2222222";
const P04 = "0.4.001-stable-20261010000000-3333333";
/** A 0.3 fix released after 0.4, which pins the stage back on 0.3. */
const P03_FIX = "0.3.010-stable-20261011000000-4444444";
const ENGINE = (line: string): string => `apps:\n  - name: erp\n    title: ERP\nengine:\n  build: example-engine\n  line: "${line}"\n`;
const PART = { "example-engine": "", "example-app": "" };

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** The tenant's registration and the engine chart's pin files as releases wrote them, oldest first. */
function world(input: { approved: Record<string, string>; appsImageTag: string; pins: Record<string, string>[]; tags?: string[]; missing?: string[] }): { ports: LineMovePorts; entry: TenantRegistration } {
  const repo = new FakePlatformRepo();
  for (const pins of input.pins) repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile(pins));
  const reader = new FakeRepoReader();
  const commits: Record<string, string> = { [B03]: SHA03, [B04]: SHA04 };
  reader.scriptFor(REPO, { tags: (input.tags ?? [B03, B04]).map((name) => ({ name, commit: commits[name]! })) });
  reader.scriptFor(`${REPO}@${B03}`, { files: { "apps.yaml": ENGINE("0.3") } });
  reader.scriptFor(`${REPO}@${B04}`, { files: { "apps.yaml": ENGINE("0.4") } });
  const approvedTags: Approvals = { erp: input.approved };
  const entry = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"),
    approvedTags, appsRepo: REPO, appsImage: "example-apps-acme", appsImageTag: input.appsImageTag,
  });
  const ports = {
    repo: reader,
    registrations: new TenantRegistrations(repo),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "example-platform", build: "example-app" }],
    registryProbe: new FakeRegistryProbe({ missing: input.missing ?? [] }),
    channelStages: async () => TEST_CHANNEL_STAGES,
  } as unknown as LineMovePorts;
  return { ports, entry };
}

const read = (w: { ports: LineMovePorts; entry: TenantRegistration }, line?: string) =>
  readLineMove(w.ports, { stage: "prod", entry: w.entry, registryHost: "zot.m1.example", ...(line ? { line } : {}), log: () => undefined, signal: new AbortController().signal });

const ON_03 = { approved: { "example-engine": P03, "example-app": P03 }, appsImageTag: `${B03}-aaaaaaa` };
const BOTH_RELEASED = [{ ...PART, "example-engine": P03, "example-app": P03 }, { "example-engine": P04_OLD, "example-app": P04_OLD }, { "example-engine": P04, "example-app": P04 }, { "example-engine": P03_FIX, "example-app": P03_FIX }];

describe("readLineMove", () => {
  it("offers the newer line of the newest bundle release, with the bundle release on it and one tag for every build of the engine's part", async () => {
    const answer = await read(world({ ...ON_03, pins: BOTH_RELEASED }));
    expect(answer).toEqual({
      line: "0.3",
      toLine: "0.4",
      refusals: [],
      standing: false,
      target: {
        line: "0.4", bundleRelease: B04, appsImageTag: `${B04}-bbbbbbb`, part: "example-platform", partTag: P04, builds: ["example-engine", "example-app"],
        approvedTags: { erp: { "example-engine": P04, "example-app": P04 } },
      },
    });
  });

  it("PLANTED DEFECT: refuses where a build of the engine's part has no release on the line at the stage, rather than move the engine alone", async () => {
    const answer = await read(world({ ...ON_03, pins: [{ "example-engine": P03, "example-app": P03 }, { "example-engine": P04, "example-app": P03 }] }), "0.4");
    expect(answer.target).toBeNull();
    expect(answer.refusals).toEqual(["no release made example-platform 0.4.x available at prod for every build of it (example-engine, example-app)"]);
  });

  it("PLANTED DEFECT: refuses a line no bundle release declares, and offers nothing where no newer line is released", async () => {
    const w = world({ ...ON_03, pins: BOTH_RELEASED, tags: [B03] });
    expect((await read(w, "0.4")).refusals).toEqual([`no release of ${REPO} that prod takes declares engine line 0.4`]);
    expect(await read(w)).toEqual({ line: "0.3", toLine: null, target: null, refusals: [], standing: false });
  });

  it("PLANTED DEFECT: refuses a line that is not newer than the tenant's", async () => {
    expect((await read(world({ ...ON_03, pins: BOTH_RELEASED }), "0.2")).refusals).toEqual(["line 0.2 is not newer than line 0.3, which tenant acme runs"]);
  });

  it("PLANTED DEFECT: refuses where an image of the pairing is not in the registry", async () => {
    const answer = await read(world({ ...ON_03, pins: BOTH_RELEASED, missing: [`example-app:${P04}`, `example-apps-acme:${B04}-bbbbbbb`] }));
    expect(answer.target).toBeNull();
    expect(answer.refusals).toEqual([`zot.m1.example/example-apps-acme:${B04}-bbbbbbb is not in the registry`, `zot.m1.example/example-app:${P04} is not in the registry`]);
  });

  it("a tenant that already carries the target pairing stands, so a rerun only watches", async () => {
    const answer = await read(world({ approved: { "example-engine": P04, "example-app": P04 }, appsImageTag: `${B04}-bbbbbbb`, pins: BOTH_RELEASED }), "0.4");
    expect(answer).toMatchObject({ line: "0.4", refusals: [], standing: true, target: { partTag: P04 } });
  });

  it("PLANTED DEFECT: a tenant on the line but not on its newest pairing is refused: within a line its releases and the Versions run move it", async () => {
    const answer = await read(world({ approved: { "example-engine": P04_OLD, "example-app": P04_OLD }, appsImageTag: `${B04}-bbbbbbb`, pins: BOTH_RELEASED }), "0.4");
    expect(answer).toMatchObject({ standing: false, target: null, refusals: ["tenant acme already runs line 0.4; within a line its releases and the Versions run move it"] });
  });

  it("throws for a tenant that runs no apps bundle: it has no line", async () => {
    const w = world({ ...ON_03, pins: BOTH_RELEASED });
    await expect(read({ ...w, entry: { ...w.entry, appsRepo: undefined, appsImage: "", appsImageTag: "" } })).rejects.toThrow(/runs no apps bundle/);
  });
});

describe("isNewerLine", () => {
  it("orders lines by their numbers, not as text", () => {
    expect(isNewerLine("0.10", "0.9")).toBe(true);
    expect(isNewerLine("1.0", "0.9")).toBe(true);
    expect(isNewerLine("0.4", "0.4")).toBe(false);
    expect(isNewerLine("0.3", "0.4")).toBe(false);
  });
});
