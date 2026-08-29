import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { inputFile } from "./defs/machine-state.ts";
import { KEYS_A_SLAVE_READS } from "./defs/deploy-slave.input.ts";
import {
  SLAVE_ID, PARAMS, CATALOGUE_TOKEN, PULL_AUTH,
  scriptedHosts, makeHarness, disposeHarnesses, hostedStepCtx, stepOf, type Harness,
} from "./deploy-slave.fixture.ts";

// THE TWO VALUES A CLUSTER THAT KEEPS NO BOOKS READS OFF ITS MACHINE, and the file they stand in
// for the length of one run.
//
// secrets/secrets.<stage> is the one hand-filled input of an installation, and it belongs to the
// cluster that keeps the books: gitignored, so no branch carries it, and written by that cluster's
// own branch programs and by nothing else. Two rows of the machine's own programs still read a
// value out of it on every cluster — the containerd mirror in deploy-cluster and the catalogue
// clone in deploy-platform-services — and neither can be gated away without breaking the machine.
//
// So the manager composes those two out of what it already holds and puts them there, and takes
// them away again. Nothing is copied off another machine, and nothing is left behind.

const PATH = inputFile(PARAMS.stage);

/** A harness with the slave's cluster row, ready to drive the two steps directly. */
async function world(hosts?: ReturnType<typeof scriptedHosts>): Promise<Harness> {
  const h = await makeHarness(hosts ? { hosts } : {});
  h.db.db.insert(clusters).values({
    id: "cls_in", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
  }).run();
  return h;
}

/** The VALUES of the placed file, as they stand in it — what a leak would leak. */
function placedValues(h: Harness): string[] {
  return (written(h)?.content ?? "")
    .split(String.fromCharCode(10))
    .flatMap((line) => /^[A-Z_]+="([^"]+)"$/.exec(line)?.[1] ?? []);
}

/** What place-input wrote on the machine, or undefined. */
function written(h: Harness): { content: string; mode: number } | undefined {
  const put = h.hosts.files.filter((f) => f.path === PATH).at(-1);
  return put ? { content: put.content, mode: put.mode } : undefined;
}

describe("the two values a machine keeping no books reads", () => {
  afterEach(disposeHarnesses);

  it("places both, out of what this manager holds and not off another machine", async () => {
    const h = await world();
    const said: string[] = [];

    await stepOf(h, "place-input").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    const file = written(h);
    expect(file, `nothing was written to ${PATH}`).toBeDefined();
    for (const key of KEYS_A_SLAVE_READS) expect(file?.content, `${key} is not in the file`).toContain(`${key}=`);
    // The catalogue credential is the manager's own (catalogueOrigin), and the pull entry comes out
    // of its own mounted document — narrowed to the one address this cluster's map names.
    expect(file?.content).toContain(CATALOGUE_TOKEN);
    expect(Buffer.from(file?.content.match(/REGISTRY_PULL_DOCKERCONFIGJSON="([^"]+)"/)?.[1] ?? "", "base64").toString("utf8"))
      .toContain(PULL_AUTH);
    // 0600, the mode the books-keeper's own input carries.
    expect(file?.mode).toBe(0o600);
    // NO SESSION READ ANOTHER CLUSTER'S SECRETS. The whole point of composing rather than carrying:
    // this step opens the file on the machine it writes to, and on no other. The master answers on
    // m1.example.com in this harness.
    const elsewhere = h.hosts.log.filter((l) => l.command.includes("secrets/secrets") && l.host !== "10.1.1.11");
    expect(elsewhere.map((l) => `${l.host}: ${l.command}`)).toEqual([]);
  });

  it("says which keys it placed and never what they are", async () => {
    // A run's surface is read by people and kept. The names are the useful half; the values are a
    // code host's token and a registry's password.
    const h = await world();
    const said: string[] = [];

    await stepOf(h, "place-input").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    const whole = said.join(" ");
    for (const key of KEYS_A_SLAVE_READS) expect(whole, "the names are said").toContain(key);
    // THE VALUES AS THEY ACTUALLY STAND IN THE FILE, taken from what was written rather than named
    // here: the pull entry is placed as a base64 DOCUMENT, so asserting the absence of the auth
    // string inside it would pass whatever the step logged.
    for (const value of placedValues(h)) {
      expect(value.length, "a placed value is a real string").toBeGreaterThan(8);
      expect(whole, `${value.slice(0, 6)}… reached the run's own surface`).not.toContain(value);
    }
  });

  it("writes nothing the second time, because the machine already carries exactly this", async () => {
    // A redeploy runs the same step against a machine mid-life. Writing an identical file again
    // would be a second act with no second effect, and the log would report one.
    const hosts = scriptedHosts();
    const h = await world(hosts);
    await stepOf(h, "place-input").run(hostedStepCtx(h));
    const first = written(h);
    expect(first).toBeDefined();
    // The machine now answers with what was put there.
    hosts.inputOut = first?.content ?? "";
    const before = h.hosts.files.length;
    const said: string[] = [];

    await stepOf(h, "place-input").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(h.hosts.files).toHaveLength(before);
    expect(said.join(" ")).toContain("already carries");
  });

  it("takes it away again, which is the whole difference from an installation's own input", async () => {
    const h = await world();
    await stepOf(h, "place-input").run(hostedStepCtx(h));
    const mark = h.hosts.log.length;

    await stepOf(h, "drop-input").run(hostedStepCtx(h));

    expect(h.hosts.log.slice(mark).some((l) => l.command === `rm -f ${PATH}`), "the file is removed").toBe(true);
  });

  it("arms that removal BEFORE the write, so a run that dies next does not leave it standing", async () => {
    // Everything between place-input and drop-input can fail — the whole machine layer stands
    // there. The cleanup is what makes the file's life bounded by the run rather than by success.
    const h = await world();
    const armed: string[] = [];

    await stepOf(h, "place-input").run(hostedStepCtx(h, { registerCleanup: (c) => armed.push(c.name) }));

    expect(armed).toEqual(["drop-input"]);
  });

  it("refuses NAMED where this manager holds neither value", async () => {
    // A manager built without a catalogue credential cannot give a machine one, and a machine that
    // keeps no books has no other source. Better to say so here than to let the machine's own
    // programs refuse by file and key three steps later.
    const h = await makeHarness({ withoutCarriedValues: true });
    h.db.db.insert(clusters).values({
      id: "cls_in2", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();

    await expect(stepOf(h, "place-input").run(hostedStepCtx(h)))
      .rejects.toThrow(/neither a catalogue credential nor its own pull configuration/);
    expect(h.hosts.files.filter((f) => f.path === PATH), "and writes nothing").toHaveLength(0);
  });
});
