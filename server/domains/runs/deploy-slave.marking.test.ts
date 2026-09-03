import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { HOST_ADDRESS_COMMAND, hostAddressesFrom } from "./defs/deploy-slave.remote.ts";
import { statedTarget } from "./defs/deploy-slave.kit.ts";
import { deploySlaveSteps } from "./defs/deploy-slave.ts";
import type { Cleanup } from "../../executor/types.ts";
import {
  SLAVE_ID, MASTER_ID, PARAMS, MASTER_MARKING_YAML,
  scriptedHosts, makeHarness, disposeHarnesses, hostedStepCtx, stepOf,
} from "./deploy-slave.fixture.ts";

// WHAT A SLAVE'S CLUSTER MAP SAYS — the manager's own git act, driven step by step.
//
// clusters/active/<fqdn>.yaml is the ONE place an installation's answers are written down, and for
// a slave the manager is its only writer: the branch cut copies the master's map aside to stamp the
// argocd files with it and renders none of its own. So everything a slave's programs and charts
// read about their installation comes from this one composition, and what it drops is written
// nowhere else.
//
// THE COMPOSITION IS THE MASTER'S MAP WITH THIS MACHINE'S FACTS OVER IT, which is why the cases
// below come in two halves: what must arrive untouched, and what must not arrive at all.
describe("a slave's cluster map, as mark-slave composes it", () => {
  afterEach(disposeHarnesses);

  // ---- mark-slave, driven directly (the map write is the manager's own git act) ------------

  it("mark-slave composes the slave's map FROM the master's and writes it onto the books branch — one address for the map and the handshake", async () => {
    const h = await makeHarness({ marking: false }); // a fresh deploy: no slave map yet
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    const armed: Cleanup[] = [];
    const checkpoints: unknown[] = [];
    const ctx = hostedStepCtx(h, { registerCleanup: (c) => armed.push(c), checkpoint: (d) => checkpoints.push(d) });
    await stepOf(h, "mark-slave").run(ctx);

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)) ?? "";
    // The slave part (what makes the slaves-appset dial it), the identity, and the inheritance —
    // every installation-wide value is the MASTER's, never asked a second time.
    for (const want of [
      // The identity is `global.domain`; the file is named for the cluster, so no `fqdn` key.
      "stage: prod", "role: slave", "  domain: s1.example.com", "  master: m1.example.com",
      // booksCluster is the slaves ApplicationSet's SELECTOR key, and a selector matches FLAT
      // top-level keys only — so it stands at the top, where a map without it is invisible to
      // the generator.
      "booksCluster: m1.example.com",
      "  apiHost: 100.64.0.11", "  apiPort: 16443", "  buildPlane: m1.example.com",
      "  unitApex: example.com", "  platformDomain: example.com",
      "  alertRecipients: ['ops@example.com']", "  catalogUrl: https://github.com/acme/acme-catalog.git",
    ]) expect(map).toContain(want);
    // The short name is DERIVED from the fqdn — never stored.
    expect(map).not.toContain("name:");
    expect(armed.map((c) => c.name)).toEqual(["remove-slave-marking"]);
    expect(checkpoints.at(-1)).toEqual({ branch: PARAMS.domain, apiHost: "100.64.0.11", changed: true });

    // Idempotent: the same composition commits nothing the second time.
    const commits = h.platformRepo.commits.length;
    await stepOf(h, "mark-slave").run(ctx);
    expect(h.platformRepo.commits).toHaveLength(commits);
    expect(checkpoints.at(-1)).toEqual({ branch: PARAMS.domain, apiHost: "100.64.0.11", changed: false });
  });

  it("writes the UNION role where the machine already carries the master part, and moves the server row onto it", async () => {
    // Deploying the slave part onto the books-keeping machine must not demote it: the map''s role
    // is what the slaves ApplicationSet matches EXACTLY (role: slave) and what the projection
    // writes onto the server row, so a flat "slave" here takes the master out of its own
    // management the moment either reader acts on it. "master+slave" is the union SERVER_ROLE
    // declares for one server doing both jobs, and this step is the code path that writes it.
    const h = await makeHarness({ marking: false });
    h.db.db.insert(clusters).values({
      id: "cls_m1", serverId: MASTER_ID, stage: "prod", domain: "m1.example.com", status: "provisioning",
    }).run();
    const steps = deploySlaveSteps(
      { target: statedTarget(MASTER_ID, "m1.example.com", "prod"), mode: "deploy" },
      { platformRepo: h.platformRepo },
    );
    await steps.find((s) => s.name === "mark-slave")?.run(hostedStepCtx(h));

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath("m1.example.com")) ?? "";
    expect(map).toContain("role: master+slave");
    expect(map).not.toContain("role: slave");
    // The union map stays out of the slaves ApplicationSet (matchLabels role: slave) and in the
    // platform selection, which is where the slave part of a self-managing machine renders.
    // The row follows the map — the combined role is reachable on a server row through this path.
    expect(h.db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get()?.role).toBe("master+slave");
  });

  it("gives a slave the installation it belongs to, and only its own facts over it", async () => {
    // WHAT A SLAVE MUST NOT GET. A map built from a handful of fields copied by name leaves out
    // keys a master carries — and what goes missing is the things every
    // program on that machine reads. Its own machine layer then stops at "is not on this host"
    // asking for the address of the secret store, measured on a real machine.
    const h = await makeHarness({ marking: false });
    h.db.db.insert(clusters).values({
      id: "cls_s2", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)) ?? "";
    // INHERITED, because they describe the installation and not the machine.
    for (const want of [
      "letsencryptEmail: ops@example.com",
      "letsencryptServer: https://acme-v02.api.letsencrypt.org/directory",
      "registryPullUser: puller",
      "registryPushUser: pusher",
      "url: https://vault.m1.example.com",
    ]) expect(map, `a slave must inherit ${want}`).toContain(want);

    // ITS OWN, because they tell one cluster of an installation from another.
    expect(map).toContain("clusterName: s1");
    expect(map).not.toContain("clusterName: m1");
    expect(map).toContain("vaultKubernetesAuthPath: kubernetes-s1");
    // AND WHAT FOLLOWS FROM WHERE THE BUILD PLANE IS: this one builds elsewhere, so its registry
    // is not local and it pulls from the cluster that does.
    expect(map).toContain("registry: false");
  });

  it("tells a slave it holds neither the secret store nor the observability stack, because it keeps no books", async () => {
    // WHAT INHERITING THE WHOLE MAP GOT WRONG. `servicesLocal` is the predicate a chart reads to
    // decide whether to reach a shared service IN-CLUSTER or over the address beside it in
    // `endpoints` — and one installation has ONE Vault and ONE observability stack, both on the
    // cluster that keeps the books. Copied off a master both said `true`. What that reaches today
    // is one reader, the CoreDNS hairpin, and the rewrite it then emits names a hostname of this
    // slave that nothing dials — so the wrong flag costs nothing YET. It is held here anyway: the
    // map is what says what a cluster runs, and this said it ran a store it does not.
    const h = await makeHarness({ marking: false });
    h.db.db.insert(clusters).values({
      id: "cls_s4", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)) ?? "";
    expect(map, "a slave runs no Vault of its own").toContain("vault: false");
    expect(map, "and no observability stack of its own").toContain("observability: false");
    // The master's map says `true` to all three, so a slave that simply copied it would say so too.
    expect(MASTER_MARKING_YAML).toContain("vault: true");
    // AND THE ADDRESSES STAY, which is the half that makes the flags usable: a chart told the
    // service is elsewhere has to be told where.
    expect(map).toContain("url: https://vault.m1.example.com");
    expect(map).toContain("url: https://idp.m1.example.com");
  });

  it("draws the fence around THIS machine, from this machine's own addresses", async () => {
    // `global.nodeCidrs` is the one global key that is a fact about the box rather than about the
    // installation, and inherited with the rest a slave's map named the MASTER's machine. Its only
    // reader is the gate sandbox fence, whose chart carries `runsOn: master` and therefore renders
    // on no slave — so this is held for what the file IS and not for what breaks: the map is the
    // ONE place an installation's answers are written down, and a wrong address there is wrong
    // wherever it is next read from.
    const h = await makeHarness({ marking: false });
    h.db.db.insert(clusters).values({
      id: "cls_s5", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));

    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)) ?? "";
    expect(map, "the slave's own address").toContain("198.51.100.11/32");
    expect(map, "and never the master's").not.toContain("203.0.113.7/32");
    expect(h.hosts.log.some((l) => l.command === HOST_ADDRESS_COMMAND), "read off the machine").toBe(true);
  });

  it("STOPS rather than write a map whose fence names nothing", async () => {
    // AN EMPTY READING IS NOT A READING. A machine carries at least one address or nothing reached
    // it — and a fence drawn around no address reports itself drawn while standing open, which is
    // worse than a run that stops here saying why.
    const h = await makeHarness({ marking: false, hosts: scriptedHosts({ hostAddressesOut: "" }) });
    h.db.db.insert(clusters).values({
      id: "cls_s6", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();

    await expect(stepOf(h, "mark-slave").run(hostedStepCtx(h))).rejects.toThrow(/lists no address of its own/);
    expect(h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)), "and writes nothing").toBeNull();
  });

  it("puts that map on the machine's own branch as well, which is the one its checkout stands on", async () => {
    // The books branch is where an installation keeps its maps and where one cluster reads about
    // another. A machine reads ITS OWN out of the tree beside it — deploy-platform-services asks
    // the file, not a branch it does not stand on.
    const h = await makeHarness({ marking: false });
    h.db.db.insert(clusters).values({
      id: "cls_s3", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));

    const own = h.platformRepo.read(PARAMS.domain, clusterMapPath(PARAMS.domain));
    const books = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain));
    expect(own, "the machine's own branch carries its map").not.toBeNull();
    // ONE MAP AND NOT TWO: written from one value in one act, so the branches cannot come to say
    // different things about one cluster.
    expect(own).toBe(books);
  });
  it("mark-slave keeps what another writer recorded: a standing release pin survives the rewrite", async () => {
    const h = await makeHarness({
      marking: [
        "stage: prod", "role: slave", "release: 1.0.0-stable-20260801120000",
        "", "global:", "  domain: s1.example.com", "  buildPlane: m1.example.com",
        "  master: m1.example.com", "  apiHost: 100.64.0.11", "  apiPort: 16443",
      ].join("\n") + "\n",
    });
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    await stepOf(h, "mark-slave").run(hostedStepCtx(h));
    const map = h.platformRepo.read(h.platformRepo.booksBranch, clusterMapPath(PARAMS.domain)) ?? "";
    expect(map).toContain("release: 1.0.0-stable-20260801120000"); // a field this manager never writes
    expect(map).toContain("  unitApex: example.com");             // the inheritance still landed
  });

  it("mark-slave in REDEPLOY mode arms NO cleanup — dropping the map part of a live slave cascades its teardown", async () => {
    const h = await makeHarness();
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "active", slaveId: 1,
    }).run();
    const steps = deploySlaveSteps(
      { target: statedTarget(SLAVE_ID, PARAMS.domain, "prod"), mode: "redeploy" },
      { platformRepo: h.platformRepo },
    );
    const armed: Cleanup[] = [];
    await steps.find((s) => s.name === "mark-slave")?.run(hostedStepCtx(h, { registerCleanup: (c) => armed.push(c) }));
    expect(armed).toEqual([]);
  });

});

describe("hostAddressesFrom", () => {
  // The manager's own lifting of what measure_host_addresses reads on a master. The two write ONE
  // file, so a second reading of the same fact must not read it a second way.
  const LISTING = [
    "1: lo    inet 127.0.0.1/8 scope host lo",
    "2: eth0    inet 198.51.100.11/24 brd 198.51.100.255 scope global eth0",
    "3: eth1    inet 10.20.0.4/16 scope global eth1",
    "5: cni0    inet 10.1.32.1/24 brd 10.1.32.255 scope global cni0",
    "7: cali7f3a inet 10.1.32.9/32 scope global cali7f3a",
    "9: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0",
  ].join(String.fromCharCode(10));

  it("takes every address the machine carries, as a /32 and not as the prefix it was configured with", () => {
    // A node configured 10.20.0.4/16 shares that /16 with every other host on the wire, and what a
    // boundary needs is the machine, not the segment.
    expect(hostAddressesFrom(LISTING)).toEqual(["198.51.100.11/32", "10.20.0.4/32"]);
  });

  it("passes over loopback, which is every host's own and identifies none of them", () => {
    expect(hostAddressesFrom("1: lo    inet 127.0.0.1/8 scope host lo")).toEqual([]);
  });

  it("passes over the interfaces a container network made, because they renumber on their own schedule", () => {
    // An address on one of these is a pod-network address the fence already denies by range, and
    // writing it down would make the machine's stated addresses churn on facts that are not about
    // the machine.
    const listed = hostAddressesFrom(LISTING);
    for (const notTheMachines of ["10.1.32.1/32", "10.1.32.9/32", "172.17.0.1/32"]) {
      expect(listed, `${notTheMachines} belongs to a container network`).not.toContain(notTheMachines);
    }
  });

  it("says nothing for a listing that carries none, because an empty reading is not a reading", () => {
    expect(hostAddressesFrom("")).toEqual([]);
  });
});
