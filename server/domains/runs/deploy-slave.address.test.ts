import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import {
  SLAVE_ID, PARAMS,
  scriptedHosts, makeHarness, disposeHarnesses, hostedStepCtx, stepOf, type Harness,
} from "./deploy-slave.fixture.ts";

// THE ADDRESS THE MASTER'S CLUSTER WILL DIAL, and where it is allowed to come from.
//
// `servers.tailnetHost` is the slave's `apiHost` in the cluster map. The address has to be the one
// the machine actually holds — its kube-apiserver answers there — while not being the machine's own
// account of itself. The coordinator is both: it assigned the address, and it is not the host being
// deployed.
//
// The column cannot be filled by hand on a first deployment. headscale 0.29.2 takes no address on
// `preauthkeys create` and has no `nodes` subcommand that sets one, so the value first exists when
// the machine registers — which happens in the rejoin step of the same run.

/** A harness whose slave carries NO address yet — a machine on its first deployment, which is the
 *  case every other suite here skips because the fixture row has carried one all along. */
async function world(hosts?: ReturnType<typeof scriptedHosts>): Promise<Harness> {
  const h = await makeHarness(hosts ? { hosts } : {});
  h.db.db.update(servers).set({ tailnetHost: null }).where(eq(servers.id, SLAVE_ID)).run();
  return h;
}

/** What the row declares now. */
function declared(h: Harness): string | null {
  return h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.tailnetHost ?? null;
}

/** A node listing as the coordinator prints it — the shape measured off headscale 0.29.2, where the
 *  id is a NUMBER and the addresses are one list with the IPv6 beside the IPv4. */
function listing(nodes: Array<{ name: string; owner: string; ips: string[] }>): string {
  return JSON.stringify(nodes.map((n, i) => ({
    id: i + 1,
    name: n.name,
    given_name: n.name,
    user: { id: i + 1, name: n.owner, created_at: { seconds: 1, nanos: 0 } },
    ip_addresses: n.ips,
    online: true,
  })));
}

/** Hosts that answer the coordinator's node list with [out], and everything else as usual. */
function coordinator(out: string, code = 0): ReturnType<typeof scriptedHosts> {
  return scriptedHosts({ coordinatorNodesOut: out, coordinatorNodesExit: code });
}

const OWNER = PARAMS.domain.split(".")[0]!;

describe("the address the coordinator gave this machine", () => {
  afterEach(disposeHarnesses);

  it("reads it ON THE MASTER and puts it on the slave's row", async () => {
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["100.64.0.7", "fd7a:115c:a1e0::7"] }]));
    const h = await world(hosts);
    const said: string[] = [];

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(declared(h)).toBe("100.64.0.7");
    // THE MACHINE BEING DEPLOYED WAS NOT ASKED. That is the whole point of the step: the host this
    // manager is about to present a token to may not be the host that names where the token goes.
    // The master answers on m1.example.com in this harness, the slave on 10.1.1.11.
    const asked = h.hosts.log.filter((l) => l.command.includes("headscale"));
    expect(asked.map((l) => l.host)).toEqual(["m1.example.com"]);
    // The coordinator is addressed the way the catalogue addresses it, at the MASTER's stage.
    expect(asked[0]?.command).toContain("deploy/headscale-prod-app");
    expect(asked[0]?.command).toContain("nodes list -o json");
    expect(said.join(" ")).toContain("100.64.0.7");
  });

  it("picks the IPv4 by shape and not by position", async () => {
    // The listing happens to put the IPv4 first today. A cluster map's apiHost carries four numbers,
    // so the choice is made on what the address IS.
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["fd7a:115c:a1e0::9", "100.64.0.9"] }]));
    const h = await world(hosts);

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h));

    expect(declared(h)).toBe("100.64.0.9");
  });

  it("replaces a stale address and says both, because a rejoin hands out a fresh one", async () => {
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["100.64.0.12"] }]));
    const h = await world(hosts);
    h.db.db.update(servers).set({ tailnetHost: "100.64.0.11" }).where(eq(servers.id, SLAVE_ID)).run();
    const said: string[] = [];

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(declared(h)).toBe("100.64.0.12");
    expect(said.join(" ")).toContain("100.64.0.11");
  });

  it("writes nothing when the row already declares what the coordinator gave", async () => {
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["100.64.0.11"] }]));
    const h = await world(hosts);
    h.db.db.update(servers).set({ tailnetHost: "100.64.0.11" }).where(eq(servers.id, SLAVE_ID)).run();
    const said: string[] = [];

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(declared(h)).toBe("100.64.0.11");
    expect(said.join(" ")).toContain("nothing to write");
  });

  it("brings the cluster map's apiHost to it, on the one branch an installation keeps maps on", async () => {
    // What consumes the map is the master's own ArgoCD entry for this cluster: the slaves
    // ApplicationSet feeds slave.apiHost into externalsecret-cluster-slave.yaml, which renders
    // `server: "https://<apiHost>:<apiPort>"` with verification on. mark-slave wrote that field
    // eight steps before the machine had an address, so it carries the machine's LAN or public name
    // — and the machine's serving certificate names its ADDRESSES and never its domain.
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["100.64.0.7"] }]));
    const h = await world(hosts);
    const path = clusterMapPath(PARAMS.domain);

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h));

    const books = h.platformRepo.booksBranch;
    expect(h.platformRepo.read(books, path) ?? "", `${books} states the coordinator's address`)
      .toContain("apiHost: 100.64.0.7");
    // AND NOWHERE ELSE. A pure slave has no branch of its own, so a second write named after the
    // machine would put a map on a branch nothing cuts and nothing reads.
    expect(h.platformRepo.read(PARAMS.domain, path), "no map on a branch of the machine's own name").toBeNull();
  });

  it("leaves the map alone when it already states that address", async () => {
    // A map rewritten for a value that did not move is a commit nobody can read, and on a redeploy
    // this step runs against a machine whose address has not changed.
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["100.64.0.11"] }]));
    const h = await world(hosts);
    const before = h.platformRepo.commits.length;
    const said: string[] = [];

    await stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h, { log: (_s, text) => said.push(text) }));

    expect(h.platformRepo.commits).toHaveLength(before);
    expect(said.join(" ")).toContain(`${clusterMapPath(PARAMS.domain)} already states apiHost 100.64.0.11`);
  });

  it("refuses where the coordinator lists no node for this machine", async () => {
    // The join earlier in the same run is what registers it, so an empty answer is a registration
    // that did not land — not a row waiting to be filled in.
    const hosts = coordinator(listing([{ name: "somebody-else", owner: "somebody-else", ips: ["100.64.0.4"] }]));
    const h = await world(hosts);

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/lists no node owned by/);
    expect(declared(h)).toBeNull();
  });

  it("refuses to CHOOSE between two nodes of the same name, and names both", async () => {
    // Not theoretical: a registration left over from an earlier life of this slave sits under
    // exactly this owner. Guessing would send the manager's token to whichever it picked.
    const hosts = coordinator(listing([
      { name: OWNER, owner: OWNER, ips: ["100.64.0.5"] },
      { name: OWNER, owner: OWNER, ips: ["100.64.0.6"] },
    ]));
    const h = await world(hosts);

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/100\.64\.0\.5.*100\.64\.0\.6/s);
    expect(declared(h)).toBeNull();
  });

  it("refuses a node the coordinator gave no IPv4", async () => {
    const hosts = coordinator(listing([{ name: OWNER, owner: OWNER, ips: ["fd7a:115c:a1e0::8"] }]));
    const h = await world(hosts);

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/no IPv4/);
  });

  it("refuses an empty listing, which is what the tool answers with null", async () => {
    // `-o json` prints `null` for an empty list — an answer, not a failure, and the same one its
    // `users list` gives.
    const h = await world(coordinator("null"));

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/lists no node owned by/);
  });

  it("refuses output that is not the coordinator's document rather than reading past it", async () => {
    const h = await world(coordinator("Error from server: pods \"headscale\" not found"));

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/not JSON/);
  });

  it("names the invocation when the coordinator cannot be addressed at all", async () => {
    const h = await world(coordinator("", 1));

    await expect(stepOf(h, "declare-tailnet-address").run(hostedStepCtx(h)))
      .rejects.toThrow(/could not be read on the master/);
  });
});
