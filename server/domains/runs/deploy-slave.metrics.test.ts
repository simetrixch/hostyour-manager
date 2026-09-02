import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { FakeMetricsQuery } from "../../adapters/metrics/testing/fake.ts";
import {
  SLAVE_ID, PARAMS, makeHarness, disposeHarnesses, hostedStepCtx, scriptedHosts, stepOf,
  type Harness,
} from "./deploy-slave.fixture.ts";

// VERIFY-SLAVE'S SOFT METRICS CHECK, and the whole of what it is: one question asked of a
// Prometheus-compatible query API over plain HTTP.
//
// Exec'ing into the Prometheus container on the master and running promtool there is the
// alternative, and `pods/exec` hands the run that pod's own ServiceAccount token and its filesystem
// on a cluster carrying pods whose ServiceAccount is cluster-admin. The same question is answered by
// a GET with no Kubernetes right at all, so what is held here is that NO exec is made and that the
// check still tells its four states apart.
//
// FOUR STATES AND NOT TWO, and the pair that must never merge is `skipped` and `unanswered`: an
// address this manager was never given and an address that answers nothing are different faults with
// different fixes, and one marker for both would hide a renamed Service behind a machine that is
// simply not pushing yet. A SKIPPED CHECK IS NOT A PASSED CHECK, so every state reaches the run log
// and the run's record in its own words.

describe("verify-slave: the metrics probe over HTTP", () => {
  afterEach(disposeHarnesses);

  /** A harness whose rows are where verify-slave finds them mid-run, with the query API it was — or
   *  deliberately was not — given. */
  async function verifyWorld(metrics?: FakeMetricsQuery | false, hostsOver: Parameters<typeof scriptedHosts>[0] = {}): Promise<Harness> {
    const h = await makeHarness({ hosts: scriptedHosts(hostsOver), ...(metrics === undefined ? {} : { metrics }) });
    h.db.db.insert(clusters).values({
      id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: PARAMS.domain, status: "provisioning", slaveId: 1,
    }).run();
    return h;
  }

    it("asks the query API about the SLAVE, and execs into no pod to do it", async () => {
    const h = await verifyWorld();
    const log: string[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { log: (_s, text) => log.push(text) }));

    expect(h.metrics?.asked).toEqual([`up{cluster="${PARAMS.domain}"}`]);
    expect(log.some((l) => l.includes("the query API sees 1 up{cluster=") && l.includes("the slave's obs-agent is pushing"))).toBe(true);
    // The right this check must not need, read off what actually reached the machines.
    for (const entry of h.hosts.log) expect(entry.command).not.toContain("exec");
    for (const entry of h.hosts.log) expect(entry.command).not.toContain("promtool");
  });

  it("says the check was SKIPPED, and why, on a manager that was given no query address", async () => {
    const h = await verifyWorld(false);
    const log: string[] = [];
    const checkpoints: unknown[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { log: (_s, text) => log.push(text), checkpoint: (d) => checkpoints.push(d) }));

    expect(log.some((l) => l.includes("metrics check SKIPPED") && l.includes("METRICS_QUERY_URL") && l.includes("nothing was measured"))).toBe(true);
    expect((checkpoints.at(-1) as { prom: string }).prom).toBe("skipped");
  });

  it("keeps an address that answered nothing APART from one that was never given", async () => {
    const h = await verifyWorld(new FakeMetricsQuery({ kind: "unanswered", detail: "getaddrinfo ENOTFOUND observability-prometheus.observability.svc.cluster.local" }));
    const log: string[] = [];
    const checkpoints: unknown[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { log: (_s, text) => log.push(text), checkpoint: (d) => checkpoints.push(d) }));

    expect(log.some((l) => l.includes("answered nothing usable") && l.includes("ENOTFOUND"))).toBe(true);
    expect((checkpoints.at(-1) as { prom: string }).prom).toBe("unanswered");
    // The whole point of the pair: two different words, so a renamed Service can never be read as a
    // manager nobody configured.
    expect(log.some((l) => l.includes("metrics check SKIPPED"))).toBe(false);
  });

  it("finds a slave that starts pushing a moment late, rather than calling it silent", async () => {
    // ONE ASK CANNOT TELL A NEW MACHINE FROM A BLOCKED ONE. A slave built seconds ago has pushed
    // nothing yet, and a check that asked once and reported silence would say something is wrong
    // about every healthy slave there is.
    const metrics = new FakeMetricsQuery({ kind: "answered", series: 1 });
    metrics.answerFirst(1, { kind: "answered", series: 0 });
    const h = await verifyWorld(metrics);
    const said: Array<{ stream: string; text: string }> = [];

    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { log: (stream, text) => said.push({ stream, text }) }));

    expect(said.some((l) => l.text.includes("the slave's obs-agent is pushing"))).toBe(true);
    expect(said.some((l) => l.stream === "stderr")).toBe(false);
    expect(metrics.asked.length).toBeGreaterThan(1);
  });

  it("says SILENCE on the stream trouble is read on, and names what stands between the two", async () => {
    // THE WHOLE POINT OF THE CHANGE. Prometheus serves the push endpoint only where the receiver is
    // on, and reaching it goes through Traefik and through whatever NetworkPolicy stands in the
    // observability namespace. A policy that misses a source denies IN SILENCE, and a run that
    // buried that among its notes would let it pass for a machine that is merely new.
    const h = await verifyWorld(new FakeMetricsQuery({ kind: "answered", series: 0 }));
    const said: Array<{ stream: string; text: string }> = [];

    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { log: (stream, text) => said.push({ stream, text }) }));

    const shout = said.find((l) => l.text.includes("THE SLAVE REPORTED NOTHING"));
    expect(shout, "silence is said out loud").toBeDefined();
    expect(shout?.stream).toBe("stderr");
    expect(shout?.text).toContain("NetworkPolicy");
    expect(shout?.text).toContain("denies in SILENCE");
  });

  it("verify-slave degrades gracefully on the SOFT checks: no metrics + no certs still succeed", async () => {
    const h = await verifyWorld(new FakeMetricsQuery({ kind: "answered", series: 0 }), { certsOut: "" });
    const checkpoints: unknown[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { checkpoint: (d) => checkpoints.push(d) }));
    // Three ExternalSecrets, because the gate counts what the instance's chart ships rather than a
    // list of names it was told to expect: cluster-slave plus the two repository credentials.
    expect(checkpoints.at(-1)).toEqual({ extSecrets: 3, apps: 2, secretStores: 2, prom: "silent", certsTotal: 0, certsReady: 0 });
  });
});
