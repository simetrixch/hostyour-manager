// The two pauses of a unit and what each one reaches.
//
// `suspended` is per STAGE and is written into registrations/<unit>/<stage>.yaml, but the build
// ApplicationSet's post-selector reads registrations/<unit>/build.yaml, which is the UNIT's one
// file. Nothing ever wrote that field, so it read false for every unit in every installation and
// the selector filtered nothing — a paused consumer went on building and on being pinned. The
// rule these tests hold: build.yaml is suspended exactly while EVERY stage the unit stands at is
// suspended, both files move in one commit, and a quiesce — the other, narrower pause — does not
// touch it.
import { describe, it, expect } from "vitest";
import { seedQuota, type UnitQuota } from "../../../shared/unit-size.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import type { ConsumerRegistration } from "../../../shared/consumer.ts";
import type { Stage } from "../../../shared/enums.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";

const REPO = "https://github.com/x/acme.git";

function unit(over: Partial<ConsumerRegistration> = {}) {
  return { name: "acme", repoURL: REPO, ...over } as ConsumerRegistration;
}

function deploy(over: Partial<{ stage: Stage; chartPath: string; cluster: string; databases: string[]; services: ConsumerRegistration["services"]; size: "small" | "medium" | "large"; mongodb: "shared" | "standalone" | "replicaset"; quota: UnitQuota; fqdn: string }> = {}) {
  return { stage: "prod" as Stage, chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"), fqdn: "acme.example.com", ...over };
}

const CLUSTERS: ClusterStageResolver = async (cluster: string) => {
  const stage = ({ s1: "prod", s1dev: "dev" } as Record<string, Stage>)[cluster];
  if (!stage) throw new Error(`no cluster map for "${cluster}"`);
  return { name: cluster, stage };
};

describe("Registry suspend / quiesce", () => {
  it("flips suspended in place — the stage file keeps its ONE path", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.setSuspended("prod", "acme", true, "run_2");
    expect(repo.commits.at(-1)!.message).toBe("suspend(acme) [run_2]");
    // The stage file is REWRITTEN where it stands — never moved to another directory. build.yaml
    // rides along because this unit stands at prod only, so pausing prod pauses the unit (below).
    expect(repo.commits.at(-1)!.write?.map((w) => w.path)).toContain("registrations/acme/prod.yaml");
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(true);
    await reg.setSuspended("prod", "acme", false, "run_3");
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(false);
  });

  // The build ApplicationSet's post-selector reads build.yaml's `suspended`, and that file is the
  // UNIT's while suspend is per STAGE. Nothing ever wrote it, so it said false for every unit in
  // every installation and the selector filtered nothing — a suspended consumer went on building.
  // These three hold the rule that makes both files true at once.
  it("stops the build only once EVERY stage of the unit is suspended", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme"], deploy: deploy(), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: ["acme"], deploy: { ...deploy(), stage: "dev", cluster: "s1dev" }, runId: "run_2" });

    // dev paused, prod still serving: the unit must keep building, or prod would never get another
    // release because someone paused dev.
    await reg.setSuspended("dev", "acme", true, "run_3");
    expect((await reg.readBuildRegistration("acme"))?.entry.suspended).toBe(false);

    // prod paused too: nothing of this unit runs anywhere, so the build stops.
    await reg.setSuspended("prod", "acme", true, "run_4");
    expect((await reg.readBuildRegistration("acme"))?.entry.suspended).toBe(true);

    // one stage back: building resumes at once, before anything is deployed.
    await reg.setSuspended("dev", "acme", false, "run_5");
    expect((await reg.readBuildRegistration("acme"))?.entry.suspended).toBe(false);
  });

  it("moves both files in ONE commit — never a window where the stage is paused and the build is not", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme"], deploy: deploy(), runId: "run_1" });
    const before = repo.commits.length;
    await reg.setSuspended("prod", "acme", true, "run_2");
    expect(repo.commits.length).toBe(before + 1);
    expect(repo.commits.at(-1)!.write?.map((w) => w.path).sort()).toEqual(["registrations/acme/build.yaml", "registrations/acme/prod.yaml"]);
  });

  it("a quiesce leaves the build alone — only a suspend can change the unit-wide answer", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: ["acme"], deploy: deploy(), runId: "run_1" });
    await reg.setQuiesced("prod", "acme", true, "run_2");
    expect(repo.commits.at(-1)!.write?.map((w) => w.path)).toEqual(["registrations/acme/prod.yaml"]);
    expect((await reg.readBuildRegistration("acme"))?.entry.suspended).toBe(false);
  });

  it("flips quiesced without disturbing suspended (the two pauses are separate intents)", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_1" });
    await reg.setSuspended("prod", "acme", true, "run_2");
    await reg.setQuiesced("prod", "acme", true, "run_3");
    const e = (await reg.readRegistration("prod", "acme"))!.entry;
    expect(e.quiesced).toBe(true);
    expect(e.suspended).toBe(true);
  });

  it("re-emits the WHOLE registration on a flip, so no field is dropped", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registry(repo, CLUSTERS);
    await reg.commitRegistration({
      unit: unit({ repoCredentialId: "cred_1", owner: "team-acme", onboardedAt: "2026-01-01T00:00:00Z" }),
      builds: [],
      deploy: deploy({ databases: ["example_auth"], services: ["postgresql"] }),
      runId: "run_1",
    });
    await reg.setSuspended("prod", "acme", true, "run_2");
    const e = (await reg.readRegistration("prod", "acme"))!.entry;
    expect(e).toMatchObject({
      name: "acme", repoURL: REPO, repoCredentialId: "cred_1", owner: "team-acme", onboardedAt: "2026-01-01T00:00:00Z",
      chartPath: "deploy/chart", cluster: "s1", databases: ["example_auth"], services: ["postgresql"],
    });
  });
});
