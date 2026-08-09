import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getRun } from "../../executor/read.ts";
import { servers } from "../../db/schema/inventory.ts";
import {
  SLAVE_ID, PARAMS, SLAVE_MARKING_YAML,
  scriptedHosts, makeHarness, disposeHarnesses, stepColumn,
} from "./deploy-slave.fixture.ts";

// ONE address, two independent sources, and the two steps that refuse a run where they disagree.
// The map feeds the master's ArgoCD cluster Secret through git; the creds blob the slave composes
// feeds Vault's kubernetes_host, the shared dashboard's kubeconfig and this process's per-slave
// kube client. A run that lets the two drift leaves the master reaching the slave for some things
// and not for others — which surfaces much later as an opaque ESO/ArgoCD failure with nothing
// naming the split. Which address the chain picks is deploy-slave.kit.test.ts's subject; that it
// reaches BOTH sources unchanged is this file's.

describe("deploy-slave — the map and the creds blob carry ONE address", () => {
  afterEach(disposeHarnesses);

  it("create-mgmt hard-fails when the slave's emit IGNORES the supplied --api-host (stale installer code)", async () => {
    // The run stated the dial address (100.64.0.11) via --api-host and wrote the SAME value into
    // the cluster map two steps earlier. A blob carrying a different address means the slave ran
    // old code that ignored the flag: Vault, the shared dashboard and this process's kube client
    // would take that address while the map's ArgoCD cluster Secret takes the other one.
    const hosts = scriptedHosts({
      emitOut: JSON.stringify({
        server: "https://10.1.87.3:16443", // a Calico-looking guess, NOT the stated address
        caData: "TFMtQ0EtREFUQQ==",
        argocdToken: "eyJhbGciOiJSUzI1NiJ9.argocd-manager-cluster-admin-SECRET-0001.sig",
        reviewerToken: "eyJhbGciOiJSUzI1NiJ9.vault-token-reviewer-SECRET-0002.sig",
      }),
    });
    const { db, executor } = await makeHarness({ hosts });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "create-mgmt")?.status).toBe("failed");
    const error = stepColumn(db, runId, "create-mgmt", "error") ?? "";
    expect(error).toContain("https://10.1.87.3:16443");
    expect(error).toContain("--api-host 100.64.0.11");
    expect(error).toMatch(/ignored the flag/);
    // The emit really carried the flag (the stated address, never a guess)...
    expect(hosts.log.some((l) => l.command.includes("--emit-mgmt-credentials --api-host 100.64.0.11"))).toBe(true);
    // ...and the run failed BEFORE --slave-add could plant the bad kubernetes_host in Vault.
    expect(hosts.log.some((l) => l.command.includes("--slave-add"))).toBe(false);
  });

  it("gitops-handoff hard-fails when the map on master names a DIFFERENT address than the run registered", async () => {
    // Reading the map back and finding only that it HAS an address would pass a map an operator
    // repointed by hand between the two steps: install.sh documents editing the map on master as
    // the supported way to change it, and that moves the git leg alone.
    const hosts = scriptedHosts();
    const { db, executor } = await makeHarness({ hosts, marking: SLAVE_MARKING_YAML.replace("100.64.0.11", "100.64.0.12") });
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "gitops-handoff")?.status).toBe("failed");
    expect(stepColumn(db, runId, "gitops-handoff", "error") ?? "").toContain("says apiHost 100.64.0.12");
    // ...and it never started waiting on the Application that map would have generated.
    expect(hosts.log.some((l) => l.command.includes("get application s1-apps"))).toBe(false);
  });

  it("a host name typed with capitals is registered, not diagnosed as a stale installer", async () => {
    // The add-server form takes the host verbatim (no lowercase rule), while the blob's URL is
    // parsed — and a URL parser lower-cases the host it reads. Comparing the two raw would fail
    // this run with "its installer ignored the flag", which is the opposite of what happened.
    const emitOut = JSON.stringify({
      // The installer composes https://<--api-host>:16443 verbatim, capitals and all.
      server: "https://S1.example.com:16443", caData: "TFMtQ0EtREFUQQ==",
      argocdToken: "eyJhbGciOiJSUzI1NiJ9.argocd-manager-cluster-admin-SECRET-0001.sig",
      reviewerToken: "eyJhbGciOiJSUzI1NiJ9.vault-token-reviewer-SECRET-0002.sig",
    });
    const hosts = scriptedHosts({ emitOut });
    const marking = SLAVE_MARKING_YAML.replace("100.64.0.11", "S1.example.com");
    const { db, executor } = await makeHarness({ hosts, marking });
    // The shape the add-server form actually produces for a box reached by name: a host and
    // nothing else. CreateServerInput.host has no lowercase rule, so the capitals survive.
    db.db.update(servers).set({ host: "S1.example.com", lanHost: null, tailnetHost: null })
      .where(eq(servers.id, SLAVE_ID)).run();
    const { runId } = await executor.plan("deploy-slave", PARAMS);
    await executor.approve(runId);
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(hosts.log.some((l) => l.command.includes("--emit-mgmt-credentials --api-host S1.example.com"))).toBe(true);
  });
});
