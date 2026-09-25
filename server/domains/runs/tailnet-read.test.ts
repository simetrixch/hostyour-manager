import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers } from "../../db/schema/inventory.ts";
import { getRun } from "../../executor/read.ts";
import { stepColumn } from "../../executor/run-rows.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import {
  disposeHarnesses, makeHarness, ELEVATION_PASSWORD, SLAVE_ID, TAILNET_ADDRESS, type Harness,
} from "./deploy-slave.fixture.ts";

// THE READING, PERFORMED — the one tailnet run kind that changes nothing on the host.
//
// It is driven end to end here rather than only planned (tailnet.test.ts holds the plan), because
// what it claims is about the ACT: no program is run, no credential is minted, no certificate is
// touched. The scripted host records every command it was sent, so that claim is read off what
// actually reached the machine.
//
// WHY IT EXISTS. A host's tailnet reading could until now be refreshed only by performing one of the
// three repairs, and the cheapest of those still re-dials the client. On a machine carrying the
// master part that is the whole of it: readMembershipStep is reached from those three and from
// deploy-slave, whose target is never the master. So the master's reading aged past
// TAILNET_READING_FRESH_MS, its chip dropped its colour, and the two buttons standing beside it were
// lit on a host that was demonstrably a member — because they were also the only refresh there was.

async function world(): Promise<Harness> {
  // The fixture's slave row carries no reading at all: the column default, which is the row a run
  // has never looked at. That is the host this run kind exists for.
  const h = await makeHarness();
  expect(h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.tailnetState).toBe("unknown");
  return h;
}

async function settle(h: Harness, kind: "cluster-tailnet-read" | "cluster-tailnet-reconnect"): Promise<string> {
  const { runId } = await h.executor.plan(kind, { serverId: SLAVE_ID });
  await h.executor.approve(runId, { [ANSIWISE_ELEVATION_SECRET]: Buffer.from(ELEVATION_PASSWORD) });
  await h.executor.settle(runId);
  return runId;
}

describe("cluster-tailnet-read — the reading that performs no repair", () => {
  afterEach(disposeHarnesses);

  it("reads a host nothing has looked at, and writes the reading on its row", async () => {
    const h = await world();
    const runId = await settle(h, "cluster-tailnet-read");

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    const row = h.db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect(row?.tailnetState).toBe("joined");
    // The reading names the run that took it, which is what lets the card link the number to a log.
    const reading = row?.tailnetJson as { runId?: string; address?: string } | null;
    expect(reading?.runId).toBe(runId);
    expect(reading?.address).toBe(TAILNET_ADDRESS);
  });

  it("sends the host the attest read and the probe, and NOTHING else", async () => {
    const h = await world();
    await settle(h, "cluster-tailnet-read");

    const sent = h.hosts.log.map((l) => l.command);
    expect(sent.some((c) => c === "cat /etc/machine-id")).toBe(true);
    expect(sent.some((c) => c.includes("dc-tailnet-probe-"))).toBe(true);
    // No program surface is opened, so no catalogue program can have run: not the disconnect, not
    // the reconnect, and not the rejoin's mint. The probe script is uploaded and run; the rest of
    // what reaches the machine is the attest read.
    expect(sent.filter((c) => c.includes("ansiwise-rest"))).toEqual([]);
    expect(sent.filter((c) => c.includes("tailscale up") || c.includes("tailscale logout"))).toEqual([]);
  });

  it("COUNTER-PROBE: a REPAIR on the same manager cannot even start, which is what the read is not", async () => {
    // The counter-probe for the assertion above. This harness is told no ANSIWISE_SERVE_COMMAND, so
    // any run kind that drives a catalogue program fails at that step by name — while the read, on
    // the same harness and the same host, succeeds. The difference is the program, not the wiring.
    const h = await world();
    const runId = await settle(h, "cluster-tailnet-reconnect");

    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(stepColumn(h.db, runId, "run-tailnet-reconnect", "error")).toMatch(/ANSIWISE_SERVE_COMMAND is not configured/);
  });
});
