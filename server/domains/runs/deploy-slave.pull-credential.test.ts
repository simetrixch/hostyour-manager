import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { redact, unregisterScope } from "../../security/redact.ts";
import { registryPullAnswer, REGISTRY_PULL_ANSWER } from "./defs/deploy-slave.ts";
import { statedTarget } from "./defs/deploy-slave.kit.ts";
import { FIXTURE_STAGE, SLAVE_MARKING_YAML } from "./cluster-maps.fixture.ts";
import {
  SLAVE_ID, PARAMS, FIXTURE_REGISTRY_HOST, PULL_AUTH, pullDocumentFor,
  makeHarness, disposeHarnesses, hostedStepCtx, type Harness,
} from "./deploy-slave.fixture.ts";

// THE VALUE A CLUSTER THAT KEEPS NO BOOKS STILL READS, and the place it may never stand.
//
// A cluster pulls its images through the installation's own registry, and deploy-cluster's
// containerd-mirror row is what writes that mirror. The cluster that keeps the books reads the
// credential out of secrets/secrets.<stage>, the installation's hand-filled input. A cluster that
// keeps none has no such file and never can: it is gitignored, so no branch carries it.
//
// So the manager composes the value out of its own mounted pull document and hands it over as an
// ANSWER of the run. What the answer buys over the file it replaces is exactly what these cases
// measure: the value reaches the machine, and it reaches NO DISK on the way — no file put there, no
// command carrying it, nothing to take away again afterwards, and nothing left standing when a run
// dies halfway.

const TARGET = statedTarget(SLAVE_ID, PARAMS.domain, FIXTURE_STAGE);

/** A harness with the slave's cluster row, so the target resolves to a domain with a map. */
async function world(opts: { withoutCarriedValues?: boolean } = {}): Promise<Harness> {
  const h = await makeHarness(opts);
  h.db.db.insert(clusters).values({
    id: "cls_pull", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
  }).run();
  return h;
}

describe("the registry pull credential a machine keeping no books is handed", () => {
  afterEach(disposeHarnesses);

  it("is composed as an answer, out of what this manager holds and not off another machine", async () => {
    const h = await world();
    const ctx = hostedStepCtx(h);

    const answers = await registryPullAnswer(TARGET, h.runPorts)(ctx);

    // The manager's OWN mounted document, narrowed to the address this cluster's map names.
    expect(answers[REGISTRY_PULL_ANSWER]).toBe(pullDocumentFor(FIXTURE_REGISTRY_HOST));
    expect(Buffer.from(String(answers[REGISTRY_PULL_ANSWER]), "base64").toString("utf8")).toContain(PULL_AUTH);
  });

  it("reaches no file and no command on any machine, which is the whole of what the answer buys", async () => {
    // THE COUNTER-PROBE. The removed steps put this value into a file on the slave at mode 0600 and
    // removed it again, and an aborted run left it standing — nothing armed a compensation, and the
    // step that took it away was an ordinary step of the list. Both halves are asserted here on the
    // shape rather than on the step names, so re-introducing the write anywhere goes red: a file put
    // on a host carrying the value, or a command carrying it.
    const h = await world();
    const ctx = hostedStepCtx(h);

    const answers = await registryPullAnswer(TARGET, h.runPorts)(ctx);
    const value = String(answers[REGISTRY_PULL_ANSWER]);

    expect(h.hosts.files.map((f) => `${f.path} ${f.content}`).filter((w) => w.includes(value))).toEqual([]);
    expect(h.hosts.log.map((l) => `${l.host} ${l.command}`).filter((w) => w.includes(value))).toEqual([]);
    // AND NO SESSION WAS OPENED AT ALL. The file this replaces was read back off the machine before
    // it was written, so composing the value used to be a reason to talk to a machine; it is not one
    // any more, and a reading that came back would be a machine mid-run holding the same credential.
    expect(h.hosts.files).toEqual([]);
    expect(h.hosts.log).toEqual([]);
  });

  it("is registered with the redactor, so it cannot stand in this run's own surface", async () => {
    const h = await world();
    const ctx = hostedStepCtx(h);
    try {
      const answers = await registryPullAnswer(TARGET, h.runPorts)(ctx);

      expect(redact(`the answer was ${String(answers[REGISTRY_PULL_ANSWER])}`)).not.toContain(PULL_AUTH);
    } finally {
      unregisterScope(ctx.runId);
    }
  });

  it("refuses NAMED where this manager holds no pull configuration of its own", async () => {
    // A manager built without one cannot give a machine one, and a machine that keeps no books has
    // no other source. Better to say so here than to install a cluster whose container runtime
    // silently pulls from the public registry, which is what the machine's own row does when the
    // credential is simply absent: it warns, writes no mirror, and reports itself satisfied.
    const h = await world({ withoutCarriedValues: true });

    await expect(registryPullAnswer(TARGET, h.runPorts)(hostedStepCtx(h)))
      .rejects.toThrow(/no pull configuration of its own/);
  });

  it("refuses NAMED where the cluster map states no registry address", async () => {
    // The address the mirror is written for is read rather than composed, so the address the charts
    // pull from and the address the runtime is pointed at are one statement. A map without it is a
    // master map without it, which is what to fix.
    const h = await world();
    const registryLines = ["    registry:", "      host: zot.m1.example.com", ""].join(String.fromCharCode(10));
    const withoutRegistry = SLAVE_MARKING_YAML.replace(registryLines, "");
    expect(withoutRegistry, "the fixture map still spells the registry endpoint the same way").not.toBe(SLAVE_MARKING_YAML);
    h.platformRepo.seed(h.platformRepo.booksBranch, `clusters/active/${PARAMS.domain}.yaml`, withoutRegistry);

    await expect(registryPullAnswer(TARGET, h.runPorts)(hostedStepCtx(h)))
      .rejects.toThrow(/states no global\.endpoints\.registry\.host/);
  });
});
