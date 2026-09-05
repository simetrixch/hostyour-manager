import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { activeClusterTarget } from "./defs/deploy-slave.kit.ts";
import { slaveMachineAnswers } from "./defs/deploy-slave.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import {
  MASTER_FQDN, MASTER_MARKING_YAML, MAP_LETSENCRYPT_EMAIL, MAP_LETSENCRYPT_SERVER,
} from "./cluster-maps.fixture.ts";
import {
  MASTER_ID, makeHarness, disposeHarnesses, hostedStepCtx, type Harness,
} from "./deploy-slave.fixture.ts";

// WHAT A PERSON IS ASKED FOR BEFORE A MASTER'S REDEPLOY, and where the run gets the rest.
//
// The end-to-end proof of this arm lives in redeploy.ansiwise.test.ts, against the real
// `ansiwise-rest serve` — and that whole file SKIPS on a machine without the ansiwise binaries, so
// the two properties below are asserted here as well, where nothing outside this process is needed:
// the plan asks for the machine password and nothing else, and the reader the arm hands
// deploy-cluster and deploy-platform-services answers them off the installation's own cluster map.
//
// WHY IT MATTERS THAT NOBODY IS ASKED. One installation registers with ONE certificate authority and
// gives it ONE mailbox, written into clusters/active/<fqdn>.yaml when the master was installed. A
// card that asks per machine collects a second copy per machine, and two copies agree only until one
// is typed differently — and deploy-cluster writes the cluster-issuer manifest from exactly those
// two values.

/** A harness whose master keeps the LIVE cluster its platform runs from — the row `cluster-redeploy`
 *  rebuilds the machine layer of, and the one `activeClusterTarget` refuses without. */
async function masterWithLiveCluster(): Promise<Harness> {
  const h = await makeHarness();
  h.db.db.insert(clusters).values({
    id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_FQDN,
    status: "active", planeState: "ready",
  }).run();
  return h;
}

/** What the arm hands `deploy-cluster` and `deploy-platform-services`, composed against [h]. */
async function machineAnswersOf(h: Harness): Promise<Record<string, string | string[]>> {
  return slaveMachineAnswers(activeClusterTarget(MASTER_ID), h.runPorts)(hostedStepCtx(h));
}

/** The master's own map with each of [lines] taken out of it — how a map that predates a key, which
 *  is what an installation generated before that key existed carries, is asked for. */
function mapWithout(...lines: string[]): string {
  return lines.reduce((map, line) => map.replace(`${line}\n`, ""), MASTER_MARKING_YAML);
}

describe("cluster-redeploy, master arm — what a person supplies and what the map answers", () => {
  afterEach(disposeHarnesses);

  it("asks for the machine password and lists no answer at all", async () => {
    const h = await masterWithLiveCluster();
    const { plan } = await h.executor.plan("cluster-redeploy", { serverId: MASTER_ID });

    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    // The six the machine-layer programs declare past the inventory — the certificate authority, its
    // mailbox, the build plane, the shared range and the two storage paths — stood on this card as
    // typed fields. They are read off the map and off the machine now, so the card is the password
    // field alone, which is what cluster-deploy-slave's master arm has always shown for this machine.
    expect(plan.requiredInputs).toBeUndefined();
  });

  it("answers the two the INSTALLATION records, the two the books-keeping says, off the master's own map", async () => {
    const h = await masterWithLiveCluster();

    const answers = await machineAnswersOf(h);

    expect(answers.letsencrypt_email).toBe(MAP_LETSENCRYPT_EMAIL);
    expect(answers.letsencrypt_server).toBe(MAP_LETSENCRYPT_SERVER);
    expect(answers.books_fqdn).toBe(MASTER_FQDN);
    expect(answers.build_plane_fqdn).toBe(MASTER_FQDN);
    // NOT ANSWERED BY THIS MANAGER AT ALL, and not by the other arm either: `lan_cidr` is declared
    // `required: false, default: ''` by the program, and no map or inventory column states it. An
    // unsent one leaves the machine sharing no range, which is what every machine deployed by this
    // manager has been told. It is named here so that adding a source for it has to move this line.
    expect(answers.lan_cidr).toBeUndefined();
    // The machine's own mount table decides the storage pair, and the scripted host names no data
    // disk — so neither answer is sent and the cluster's volumes stay where the snap puts them.
    expect(answers.storage_mount).toBeUndefined();
    expect(answers.storage_subdirectory).toBeUndefined();
  });

  it("PLANTED DEFECT: a map that records no mailbox and no authority sends neither, so the program refuses by name", async () => {
    // THE COUNTER-PROBE OF THE CASE ABOVE. Without it, four values read off a fixture map could
    // equally be four values something invented, and the point of this change is that nothing here
    // invents one: deploy-cluster declares both with no default, so an answer this manager does not
    // send is refused BY NAME on the machine — a sentence naming the key to write into the map —
    // rather than defaulted into a certificate manifest nobody chose.
    const h = await masterWithLiveCluster();
    h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_FQDN), mapWithout(
      `  letsencryptEmail: ${MAP_LETSENCRYPT_EMAIL}`,
      `  letsencryptServer: ${MAP_LETSENCRYPT_SERVER}`,
    ));

    const answers = await machineAnswersOf(h);

    expect(answers.letsencrypt_email).toBeUndefined();
    expect(answers.letsencrypt_server).toBeUndefined();
    // PLANTED INNOCENT beside it: the keys that ARE in that same map still come through, so an
    // absent pair means those two were missing and not that the reader stopped reading.
    expect(answers.books_fqdn).toBe(MASTER_FQDN);
    expect(answers.build_plane_fqdn).toBe(MASTER_FQDN);
  });

  it("refuses a server whose cluster is not live, before any answer is composed", async () => {
    // The arm's own guard, and the reason the target is a lookup rather than a frozen pair: a
    // redeploy rebuilds a LIVE cluster's machine layer, and a planned one is deploy-slave's to finish.
    const h = await makeHarness();
    h.db.db.update(servers).set({ role: "master" }).where(eq(servers.id, MASTER_ID)).run();
    h.db.db.insert(clusters).values({
      id: "cls_master", serverId: MASTER_ID, stage: "prod", domain: MASTER_FQDN,
      status: "planned",
    }).run();

    const refused = await machineAnswersOf(h).catch((e: unknown) => e);

    expect((refused as Error).message).toContain("redeploy rebuilds a LIVE cluster");
  });
});
