import { describe, it, expect, afterEach, vi } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { AppError } from "../../kernel/errors.ts";
import { argocdFollowStep } from "./defs/live-cluster.kit.ts";
import { statedTarget } from "./defs/deploy-slave.kit.ts";
import { FIXTURE_STAGE, MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { MASTER_ARGO_NS, SLAVE_ARGO_NS, argoRow } from "./deploy-slave.kube.fixture.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, makeHarness, disposeHarnesses, hostedStepCtx, stepOf,
  seedMasterCluster, drainToNextTimer, type Harness,
} from "./deploy-slave.fixture.ts";

// THE THREE STEPS THAT READ ARGOCD, and the one thing they no longer do.
//
// gitops-handoff, verify-slave's two master-side HARD gates and argocd-follow used to read ArgoCD by
// running `microk8s kubectl` over an SSH session, raising every one of those reads to root with the
// machine's elevation password, every ten seconds, for up to thirty minutes. They read it through
// the Manager pod's own ServiceAccount now — the same port every consumer and tenant run kind
// already resolves through, and the RBAC for both reads already stands on the Manager's grants.
//
// WHAT IS MEASURED HERE is therefore where the read went, not what it returned: no command reaches
// the master from these steps at all, and the reader really was asked. The planted defect at the
// foot of the file is a read put back on the session, which is the shape this change could regress
// into and the one every assertion above it has to catch.

const MASTER_HOST = "m1.example.com";
const SLAVE_HOST = "10.1.1.11";

/** A world where the slave is mid-deployment and the master carries the row every ArgoCD read
 *  resolves through. */
async function world(): Promise<Harness> {
  const h = await makeHarness();
  h.db.db.insert(clusters).values({
    id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
  }).run();
  seedMasterCluster(h);
  return h;
}

/** A world whose MASTER is the live cluster argocd-follow acts on — redeploy's own arm. */
async function masterWorld(): Promise<Harness> {
  const h = await makeHarness();
  seedMasterCluster(h);
  return h;
}

const commandsTo = (h: Harness, host: string): string[] =>
  h.hosts.log.filter((l) => l.host === host).map((l) => l.command);

describe("the three ArgoCD reads of a cluster deployment", () => {
  afterEach(disposeHarnesses);

  it("gitops-handoff sends the master nothing and watches the generated Application through the kube port", async () => {
    const h = await world();
    const said: string[] = [];

    await stepOf(h, "gitops-handoff").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    // It really watched, and it watched the GENERATED name in the master's own root instance.
    expect(h.argo.watched).toEqual([`${MASTER_ARGO_NS}/s1-apps`]);
    expect(said.join(" ")).toContain("s1-apps is Synced");
    // And it sent the master nothing at all — so nothing in it read the elevation password.
    expect(commandsTo(h, MASTER_HOST)).toEqual([]);
  });

  it("a converging verify-slave sends the master no command, and still sends the slave its own two reads", async () => {
    const h = await world();

    await stepOf(h, "verify-slave").run(hostedStepCtx(h));

    // HARD 0 and HARD 1 went through the port, on the per-slave instance's namespace.
    expect(h.cluster.listedExternalSecrets).toEqual([SLAVE_ARGO_NS]);
    expect(h.argo.listed).toEqual([SLAVE_ARGO_NS]);
    // The master was sent nothing. The diagnostic bundle is the one thing that still goes there, and
    // it runs only while a HARD gate is FAILING — this one converged on its first tick.
    expect(commandsTo(h, MASTER_HOST)).toEqual([]);
    // The slave still carries HARD 2's SecretStores read and SOFT 2's Certificates read.
    const onSlave = commandsTo(h, SLAVE_HOST);
    expect(onSlave.filter((c) => c.includes("secretstores.external-secrets.io"))).toHaveLength(1);
    expect(onSlave.filter((c) => c.includes("certificates.cert-manager.io"))).toHaveLength(1);
  });

  it("argocd-follow sends no session command at all, and reads the namespace the resolver hands back", async () => {
    const h = await masterWorld();
    const said: string[] = [];

    await argocdFollowStep(statedTarget(MASTER_ID, MASTER_FQDN, FIXTURE_STAGE), h.runPorts)
      .run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(h.argo.listed).toEqual([MASTER_ARGO_NS]);
    expect(said.join(" ")).toContain(`all 1 applications in ns ${MASTER_ARGO_NS} are Synced + Healthy`);
    expect(h.hosts.log).toEqual([]);
  });

  it("argocd-follow RETRIES a namespace holding zero Applications rather than passing it", async () => {
    // The ApplicationSet has not generated anything yet. Zero found is the case a set-watch keyed by
    // EXPECTED names cannot tell from "all converged" — asked with an empty expected list its map is
    // empty and any `every`-shaped predicate over it is vacuously true on the first tick. That is
    // why this reads a LIST of what the namespace holds.
    const h = await masterWorld();
    h.argo.setApplications(MASTER_ARGO_NS, []);
    const said: string[] = [];
    const step = argocdFollowStep(statedTarget(MASTER_ID, MASTER_FQDN, FIXTURE_STAGE), h.runPorts);

    vi.useFakeTimers();
    try {
      const done = step.run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));
      await drainToNextTimer();
      expect(said.join(" ")).toContain("no Applications generated yet");
      h.argo.setApplications(MASTER_ARGO_NS, [argoRow("platform-apps-prod")]); // the appset generated
      await vi.advanceTimersByTimeAsync(15_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(said.join(" ")).toContain("all 1 applications");
  });

  it("PLANTED DEFECT: a kube read that throws is a failing TICK for argocd-follow too, and it converges on the next one", async () => {
    // This step runs right after deploy-platform-services restarted kubelite on the master arm, and
    // the Manager's own reader is on that API server: the pod loses it mid-follow by design. A step
    // that died on the first UPSTREAM would fail a redeploy for the restart the redeploy asked for.
    const h = await masterWorld();
    h.argo.setListFailure(new AppError("UPSTREAM", "list Argo Applications in argocd: connect ECONNREFUSED"));
    const step = argocdFollowStep(statedTarget(MASTER_ID, MASTER_FQDN, FIXTURE_STAGE), h.runPorts);
    const said: string[] = [];

    vi.useFakeTimers();
    try {
      const done = step.run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));
      await drainToNextTimer();
      expect(said.join(" ")).toContain("the kube API did not answer");
      h.argo.setListFailure(undefined); // the API server is back
      await vi.advanceTimersByTimeAsync(15_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(said.join(" ")).toContain("all 1 applications");
  });

  it("PLANTED INNOCENT: the slave's own two reads still go over its session, raised", async () => {
    // The counter-probe of every "sends nothing" above. Without it, a step list that stopped
    // reaching a machine ALTOGETHER — one that never ran, or a harness that logged no command —
    // would pass each of them by measuring nothing.
    const h = await world();

    await stepOf(h, "verify-slave").run(hostedStepCtx(h));

    expect(commandsTo(h, SLAVE_HOST)).not.toEqual([]);
  });
});
