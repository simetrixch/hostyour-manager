import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { masterTakingSlavePart, MASTER_AND_SLAVE_ROLE, masterSelfTarget, branchAnswers } from "./defs/deploy-slave.master.ts";
import { MANAGER_COMMITTER_NAME, MANAGER_COMMITTER_EMAIL } from "../../adapters/git/git.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { hostedStepCtx } from "./deploy-slave.fixture.ts";
import { MASTER_MARKING_YAML } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { MASTER_ID, SLAVE_ID, makeHarness, disposeHarnesses, type Harness } from "./deploy-slave.fixture.ts";

// THE MASTER ARM of cluster-deploy-slave — the machine that carries the master part taking the slave
// part as well. It is a different act from the other arm and the plan is where a person meets that
// difference: one host instead of two, the machine's OWN branch regenerated under the combined role
// instead of a branch cut for a new machine, and not one compensating action armed.
//
// WHAT THE CARD SAYS IS ASSERTED HERE AND NOT ONLY THAT THE STEPS COMPOSE, because the summary is
// the whole of what the approve screen renders about a run (RunView carries a summary and no
// warnings): a person types the password of the machine this manager itself runs on into that
// screen, and what they are told the run does is these sentences.
//
// AND THE TWO REFUSALS, which say where the act cannot hold: a machine that is not this manager's
// own master, and a master that carries the slave part already.

const MASTER_DOMAIN = "m1.example.com";
const MASTER_PARAMS = { serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN };

/** A harness whose master keeps the LIVE cluster its platform runs from — the row the slave part is
 *  added to, and the one the arm refuses without. */
async function masterWithLiveCluster(): Promise<Harness> {
  const h = await makeHarness();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN,
    status: "active", planeState: "ready",
  }).run();
  return h;
}

describe("cluster-deploy-slave, master arm — the plan, what it says, and where it refuses", () => {
  afterEach(disposeHarnesses);

  it("plans ONE host and ONE cluster: first contact, the regeneration under the combined role, and the machine layer", async () => {
    const h = await masterWithLiveCluster();
    const { plan } = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS);
    expect(plan.steps.map((s) => s.name)).toEqual([
      "attest-target",
      "prove-elevation", "generate-key", "install-key", "verify-key-login", "remove-sudoers",
      "place-ansiwise", "run-deploy-branch", "project-marking",
      "run-deploy-host", "run-deploy-cluster", "run-deploy-platform-services", "argocd-follow",
    ]);
    // The machine IS the master, so there is no master-side half and no per-slave Vault surgery for
    // another run to interleave with — one owned target, and no master-vault lock.
    expect(plan.targets).toEqual([{ serverId: MASTER_ID, ownsHost: true, label: "m1 (master)" }]);
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: MASTER_DOMAIN },
      { resource: "master-kube", key: "m" },
    ]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
  });

  it("says on the approve card that it regenerates the master's OWN branch, builds no second cluster and no plane, and arms nothing", async () => {
    // THE THREE THINGS A PERSON MUST NOT READ AS THE OTHER ARM. Deploying a slave writes a second
    // cluster row, allocates an ordinal, builds that slave a management plane and arms compensations
    // that put the machine back; this run does none of it, on the host this manager runs from.
    const h = await masterWithLiveCluster();
    const { plan } = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS);
    expect(plan.summary).toContain("already carries the master part");
    expect(plan.summary).toContain(`branch ${MASTER_DOMAIN} is regenerated under role ${MASTER_AND_SLAVE_ROLE}`);
    expect(plan.summary).toContain("no ordinal is allocated");
    expect(plan.summary).toContain("no second cluster row is written");
    expect(plan.summary).toContain("no per-slave management plane is built");
    expect(plan.summary).toContain("NOT ONE COMPENSATING ACTION IS ARMED");
    expect(plan.summary).toContain("an abort leaves the machine as the last completed step left it");
    expect(plan.summary).toContain("the way back is running this run again");
  });

  it("refuses a master that already carries the slave part, and names what rebuilds its machine layer", async () => {
    const h = await masterWithLiveCluster();
    h.db.db.update(servers).set({ role: MASTER_AND_SLAVE_ROLE }).where(eq(servers.id, MASTER_ID)).run();
    const err = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain(`already stands at role ${MASTER_AND_SLAVE_ROLE}`);
    expect((err as AppError).message).toContain("cluster-redeploy");
  });

  it("still composes its own steps for a machine at the combined role, so a run that stopped part way is finished by running it again", async () => {
    // The refusal above is the PLAN's and never the steps': `project-marking` moves the row onto the
    // combined role part way through, so a run that then failed in the machine layer would be
    // unfinishable if the step list refused what the plan does.
    const h = await masterWithLiveCluster();
    h.db.db.update(servers).set({ role: MASTER_AND_SLAVE_ROLE }).where(eq(servers.id, MASTER_ID)).run();
    const def = buildRunDefinitions(h.runPorts).get("cluster-deploy-slave") as AnyRunDefinition;
    expect(def.steps({ ...MASTER_PARAMS }).map((s) => s.name))
      .toContain("run-deploy-branch");
  });

  it("refuses a machine that is not this manager's own master", async () => {
    // `servers_one_master_uq` admits one row carrying a master part, and every master-side act of
    // every run kind resolves that row through loadMaster — so the arm asks the same equality rather
    // than trusting the role column of whichever row it was handed.
    const h = await masterWithLiveCluster();
    expect(() => masterTakingSlavePart(h.db.db, SLAVE_ID)).toThrow(/master part of this installation is carried by m1/);
  });

  it("refuses a master with no cluster of its own, and one whose cluster is not live", async () => {
    // The slave part is added to the cluster the master already keeps, so there has to be one and it
    // has to be the live one its platform runs from.
    const h = await makeHarness();
    const none = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect((none as AppError).message).toContain("records no cluster for it");

    h.db.db.insert(clusters).values({
      id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_DOMAIN, status: "planned",
    }).run();
    const notLive = await h.executor.plan("cluster-deploy-slave", MASTER_PARAMS).catch((e: unknown) => e);
    expect((notLive as AppError).message).toContain("takes the slave part on its own LIVE cluster");
  });

  it("refuses a domain or a stage that is not the master's own, because one machine keeps one cluster", async () => {
    const h = await masterWithLiveCluster();
    const otherDomain = await h.executor.plan("cluster-deploy-slave", { ...MASTER_PARAMS, domain: "s9.example.com" })
      .catch((e: unknown) => e);
    expect((otherDomain as AppError).message).toContain("a second domain needs a machine of its own");
    const otherStage = await h.executor.plan("cluster-deploy-slave", { ...MASTER_PARAMS, stage: "test" })
      .catch((e: unknown) => e);
    expect((otherStage as AppError).message).toContain("a cluster carries one stage");
  });

  // WHAT THE REGENERATION IS ANSWERED WITH, and it is the half a plan cannot show: the answers are
  // composed when the step runs, off the installation's own map. Measured on a real run before this
  // existed: the machine refused to start the program with ten sentences, each naming an answer that
  // stood written down in a file this manager already reads.
  describe("the answers the regeneration is given", () => {
    // The same map with the line a released installation carries. Written as a template literal
    // because the line IS a line: a map whose release sat on the end of another key would be a
    // different file, and this test would then prove nothing about the one the lifecycle writes.
    const withRelease = MASTER_MARKING_YAML.replace("role: master", `role: master
release: 0.7.9-stable-20260903202414`);

    async function answersOf(h: Harness): Promise<Record<string, string | string[]>> {
      const target = masterSelfTarget(MASTER_ID, { domain: MASTER_DOMAIN, stage: "prod" });
      return branchAnswers(target, MASTER_ID, h.runPorts)(hostedStepCtx(h));
    }

    it("reads every one of them off the map, and commits as this manager", async () => {
      const h = await masterWithLiveCluster();
      h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_DOMAIN), withRelease);
      // A real master's row carries one - the run that deploys from it connects over that address -
      // and the fixture's does not, so the case that reads the answers has to state it.
      h.db.db.update(servers).set({ lanHost: "10.1.1.5" }).where(eq(servers.id, MASTER_ID)).run();

      const answers = await answersOf(h);

      // The ten the machine named, and the role this arm overrules the inventory with.
      expect(answers.platform_ref).toBe("0.7.9-stable-20260903202414");
      expect(answers.platform_repo).toBeDefined();
      expect(answers.build_plane_fqdn).toBe(MASTER_DOMAIN);
      expect(answers.unit_apex).toBe("example.com");
      expect(answers.platform_domain).toBe("example.com");
      expect(answers.alert_recipients).toBeDefined();
      // NOT one of the ten: the machine never named it, because the program defaults it rather than
      // demanding it. That default is platform-local, so an unanswered issuer is a silent reissue of
      // every certificate from the cluster's own root.
      expect(answers.cluster_issuer).toBe("platform-acme");
      expect(answers.lan_host).toBe("10.1.1.5");
      expect(answers.role).toBe(MASTER_AND_SLAVE_ROLE);
      // Not an inference: it is the identity this manager already commits into this repository under.
      expect(answers.committer_name).toBe(MANAGER_COMMITTER_NAME);
      expect(answers.committer_email).toBe(MANAGER_COMMITTER_EMAIL);
    });

    it("refuses an installation whose map records no release, rather than bringing it to the trunk", async () => {
      // The fixture's master map carries no release line, which is what a machine looks like before a
      // platform release has been cut onto it - measured on a real installation the same evening.
      const h = await masterWithLiveCluster();

      const refused = await answersOf(h).catch((e: unknown) => e);

      expect((refused as AppError).message).toContain("records no release");
      expect((refused as AppError).message).toContain("Cut a platform release onto this installation first");
    });

    it("refuses a map that names no certificate authority, rather than letting the default reissue", async () => {
      // Measured on apps6 on 2026-09-04: the map carried no clusterIssuer, this arm passed none, the
      // program's default of platform-local won, and the run deleted the platform-acme issuer and
      // reissued every address of the installation from a root nothing outside the machine trusts —
      // reporting itself green. The other answers are spread only where the map carries them, which
      // is harmless for a value whose default is inert; this one is passed unconditionally.
      const h = await masterWithLiveCluster();
      h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_DOMAIN),
        withRelease.replace("  clusterIssuer: platform-acme\n", ""));
      h.db.db.update(servers).set({ lanHost: "10.1.1.5" }).where(eq(servers.id, MASTER_ID)).run();

      const refused = await answersOf(h).catch((e: unknown) => e);

      expect((refused as AppError).message).toContain("records no clusterIssuer");
      expect((refused as AppError).message).toContain("platform-acme or platform-local");
    });

    it("refuses a server row with no LAN address, which the gate is proven against", async () => {
      const h = await masterWithLiveCluster();
      h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_DOMAIN), withRelease);
      h.db.db.update(servers).set({ lanHost: null }).where(eq(servers.id, MASTER_ID)).run();

      const refused = await answersOf(h).catch((e: unknown) => e);

      expect((refused as AppError).message).toContain("carries no LAN address");
    });
  });
});
