import { describe, it, expect, afterEach } from "vitest";
import { servers, clusters } from "../../db/schema/inventory.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import {
  CONCURRENT_STEPS, activeSlaves, fleetStep, redeploySlavesSteps, slaveCtx, type FleetSlave,
} from "./defs/redeploy-slaves.ts";
import { MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { SLAVE_ID, MASTER_ID, makeHarness, disposeHarnesses, hostedStepCtx, type Harness } from "./deploy-slave.fixture.ts";

// cluster-redeploy-slaves — one slave's redeploy steps, each run for every active slave: at once where
// a step acts on the slave alone, one after the other where it writes the master.

const S1: FleetSlave = { serverId: "srv_a", name: "apps1", domain: "apps1.example.com" };
const S2: FleetSlave = { serverId: "srv_b", name: "apps2", domain: "apps2.example.com" };

/** A context that records what the fleet does with it. */
function recordingCtx(): { ctx: StepCtx; lines: string[]; sessions: (string | undefined)[]; checkpoint: { data?: unknown } } {
  const lines: string[] = [];
  const sessions: (string | undefined)[] = [];
  const checkpoint: { data?: unknown } = {};
  const logger = { child: () => logger } as unknown as StepCtx["logger"];
  const ctx = {
    runId: "run_x",
    stepName: "fleet",
    params: {},
    signal: new AbortController().signal,
    logger,
    ssh: async (id?: string) => {
      sessions.push(id);
      return {} as never;
    },
    attest: async () => {},
    openPasswordSession: async () => ({}) as never,
    closePasswordSession: () => {},
    log: (_stream: string, text: string) => lines.push(text),
    checkpoint: (data: unknown) => {
      checkpoint.data = data;
    },
    readCheckpoint: <T>() => checkpoint.data as T | undefined,
    registerCleanup: () => {},
  } as unknown as StepCtx;
  return { ctx, lines, sessions, checkpoint };
}

/** A step whose run waits for [gate] and records when it began and ended. */
function gatedStep(name: string, trace: string[], gate: Promise<void>, fail = false): Step {
  return {
    name,
    title: name,
    run: async (ctx) => {
      const who = String(ctx.params.serverId);
      trace.push(`start ${who}`);
      await gate;
      trace.push(`end ${who}`);
      if (fail) throw new Error(`broken on ${who}`);
    },
  };
}

describe("a step run for every slave", () => {
  it("runs a concurrent step on every slave at once", async () => {
    const trace: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const step = fleetStep("run-deploy-host", "Deploy host", [
      { slave: S1, step: gatedStep("a", trace, gate) },
      { slave: S2, step: gatedStep("b", trace, gate) },
    ], true);
    const running = step.run(recordingCtx().ctx);
    await Promise.resolve();
    // Both began before either could finish: the gate is still shut.
    expect(trace).toEqual(["start srv_a", "start srv_b"]);
    open();
    await running;
  });

  it("PLANTED DEFECT: a serial step lets the next slave begin only after the one before it ended", async () => {
    const trace: string[] = [];
    const step = fleetStep("mark-slave", "Mark", [
      { slave: S1, step: gatedStep("a", trace, Promise.resolve()) },
      { slave: S2, step: gatedStep("b", trace, Promise.resolve()) },
    ], false);
    await step.run(recordingCtx().ctx);
    expect(trace).toEqual(["start srv_a", "end srv_a", "start srv_b", "end srv_b"]);
  });

  it("finishes the step on the other slaves and then fails, naming the slave it failed on", async () => {
    const trace: string[] = [];
    const step = fleetStep("create-mgmt", "Mgmt", [
      { slave: S1, step: gatedStep("a", trace, Promise.resolve(), true) },
      { slave: S2, step: gatedStep("b", trace, Promise.resolve()) },
    ], false);
    await expect(step.run(recordingCtx().ctx)).rejects.toThrow(/create-mgmt failed on 1 of 2 slave\(s\) — apps1: broken on srv_a/);
    expect(trace).toContain("end srv_b");
  });

  it("names the slaves an abort left out of a serial step, rather than ending it green", async () => {
    const { ctx } = recordingCtx();
    const abort = new AbortController();
    const aborting: Step = { name: "a", title: "a", run: async () => abort.abort() };
    const never: Step = { name: "b", title: "b", run: async () => { throw new Error("ran after the abort"); } };
    const step = fleetStep("register", "Register", [{ slave: S1, step: aborting }, { slave: S2, step: never }], false);
    await expect(step.run({ ...ctx, signal: abort.signal })).rejects.toThrow(/apps2: not run, because the run was aborted/);
  });
});

describe("the context a slave's step is handed", () => {
  it("defaults the session and params.serverId to that slave, and passes a named server through", async () => {
    const { ctx, sessions } = recordingCtx();
    const scoped = slaveCtx(ctx, S1);
    await scoped.ssh();
    await scoped.ssh(MASTER_ID);
    expect(sessions).toEqual(["srv_a", MASTER_ID]);
    expect(scoped.params.serverId).toBe("srv_a");
  });

  it("names the slave on every line it logs", () => {
    const { ctx, lines } = recordingCtx();
    slaveCtx(ctx, S2).log("meta", "one\ntwo");
    expect(lines).toEqual(["[apps2] one\n[apps2] two"]);
  });

  it("keeps each slave's checkpoint apart, so two slaves writing do not overwrite each other", () => {
    const { ctx } = recordingCtx();
    slaveCtx(ctx, S1).checkpoint({ changed: true });
    slaveCtx(ctx, S2).checkpoint({ changed: false });
    expect(slaveCtx(ctx, S1).readCheckpoint()).toEqual({ changed: true });
    expect(slaveCtx(ctx, S2).readCheckpoint()).toEqual({ changed: false });
  });

  it("refuses the password door, naming the slave, because the run's one door reaches another machine", async () => {
    const { ctx } = recordingCtx();
    await expect(slaveCtx(ctx, S1).openPasswordSession(ANSIWISE_ELEVATION_SECRET)).rejects.toThrow(/apps1 does not take this manager's key/);
  });
});

describe("cluster-redeploy-slaves, planned against the inventory", () => {
  afterEach(disposeHarnesses);

  /** The fixture's slave and a second one, both live, beside the master's own cluster. */
  async function twoLiveSlaves(): Promise<Harness> {
    const h = await makeHarness();
    h.db.db.insert(servers).values({
      id: "srv_slave2", name: "s2", host: "s2.example.com", lanHost: "10.1.1.12", tailnetHost: "100.64.0.12",
      sshPort: 22, sshUser: "ubuntu", role: "slave", status: "healthy",
    }).run();
    h.db.db.insert(clusters).values([
      { id: "cls_m", serverId: MASTER_ID, stage: "prod", domain: MASTER_FQDN, name: MASTER_FQDN.split(".")[0]!, status: "active", planeState: "ready" },
      { id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", name: "s1", status: "active", slaveId: 1 },
      { id: "cls_s2", serverId: "srv_slave2", stage: "prod", domain: "s2.example.com", name: "s2", status: "active", slaveId: 2 },
    ]).run();
    return h;
  }

  it("takes every live pure slave and leaves the master out", async () => {
    const h = await twoLiveSlaves();
    expect(activeSlaves(h.db.db).map((s) => s.name)).toEqual(["s1", "s2"]);
  });

  it("holds once what every slave's redeploy claims, and targets every slave and the master", async () => {
    const h = await twoLiveSlaves();
    const { plan } = await h.executor.plan("cluster-redeploy-slaves", {});
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.targets?.map((t) => [t.serverId, t.ownsHost])).toEqual([[SLAVE_ID, true], ["srv_slave2", true], [MASTER_ID, false]]);
    expect(plan.locks).toEqual(expect.arrayContaining([
      { resource: "git-branch", key: "s1.example.com" },
      { resource: "git-branch", key: "s2.example.com" },
      { resource: "git-branch", key: MASTER_FQDN },
      { resource: "master-vault", key: "m" },
      { resource: "master-kube", key: "m" },
    ]));
    expect(plan.steps[0]?.name).toBe("attest-target");
  });

  it("refuses a run when no slave is live", async () => {
    const h = await makeHarness();
    await expect(h.executor.plan("cluster-redeploy-slaves", {})).rejects.toThrow(/no slave carries an active cluster/);
  });

  it("knows every concurrent step by a name the slave's redeploy really has, and keeps the master's writes serial", async () => {
    const h = await twoLiveSlaves();
    const names = redeploySlavesSteps(activeSlaves(h.db.db), h.runPorts).map((s) => s.name);
    for (const name of CONCURRENT_STEPS) expect(names, `${name} is a step of a slave's redeploy`).toContain(name);
    for (const name of ["mark-slave", "place-ansiwise-master", "join-if-absent", "declare-tailnet-address", "create-mgmt", "register", "headlamp-contexts"]) {
      expect(names).toContain(name);
      expect(CONCURRENT_STEPS.has(name), `${name} writes the master and runs one slave after the other`).toBe(false);
    }
  });

  it("hands each slave's step the context of that slave", async () => {
    const h = await twoLiveSlaves();
    const seen: string[] = [];
    const probe: Step = { name: "probe", title: "Probe", run: async (ctx) => void seen.push(String(ctx.params.serverId)) };
    const slaves = activeSlaves(h.db.db);
    await fleetStep("probe", "Probe", slaves.map((slave) => ({ slave, step: probe })), true).run(hostedStepCtx(h));
    expect(seen.sort()).toEqual([SLAVE_ID, "srv_slave2"]);
  });
});
