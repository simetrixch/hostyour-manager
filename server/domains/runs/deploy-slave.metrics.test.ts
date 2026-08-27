import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { FakeMetricsQuery } from "../../adapters/metrics/testing/fake.ts";
import {
  SLAVE_ID, PARAMS, makeHarness, disposeHarnesses, hostedStepCtx, scriptedHosts, stepOf,
  type Harness,
} from "./deploy-slave.fixture.ts";

// VERIFY-SLAVE'S SOFT METRICS CHECK, and the whole of what it is now: one question asked of a
// Prometheus-compatible query API over plain HTTP.
//
// It used to exec into the Prometheus container on the master and run promtool there, and
// `pods/exec` hands the run that pod's own ServiceAccount token and its filesystem on a cluster
// carrying pods whose ServiceAccount is cluster-admin. The same question is answered by a GET with
// no Kubernetes right at all, so what is held here is that the exec is GONE and that the check still
// tells its four states apart.
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
    // The right this check used to need, read off what actually reached the machines.
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

  it("verify-slave degrades gracefully on the SOFT checks: no metrics + no certs still succeed", async () => {
    const h = await verifyWorld(new FakeMetricsQuery({ kind: "answered", series: 0 }), { certsOut: "" });
    const checkpoints: unknown[] = [];
    await stepOf(h, "verify-slave").run(hostedStepCtx(h, { checkpoint: (d) => checkpoints.push(d) }));
    // Three ExternalSecrets, because the gate counts what the instance's chart ships rather than a
    // list of names it was told to expect: cluster-slave plus the two repository credentials.
    expect(checkpoints.at(-1)).toEqual({ extSecrets: 3, apps: 2, secretStores: 2, prom: "empty", certsTotal: 0, certsReady: 0 });
  });
});
