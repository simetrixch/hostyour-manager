// The enable-gates of buildOnboarding (wire-onboarding.ts). The load-bearing regression here: kube
// access NEVER gates a family — the clients default to the pod ServiceAccount's in-cluster
// credentials, so onboarding must come up WITHOUT a KUBECONFIG_PATH (the old Vault-mounted
// kubeconfig design required one and 501'd without it). Constructing the real adapters is safe in
// a unit test: every kube loader only populates the KubeConfig object — no cluster IO happens
// until a Run actually calls out.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { buildOnboarding } from "./wire-onboarding.ts";
import { RUN_FAMILY } from "../../shared/enums.ts";
import type { StepCtx } from "../executor/types.ts";

// The kinds each family declares (shared/enums.ts RUN_FAMILY) — compared against the defs the builder
// actually produces, so the declaration the registry.total boot check reasons about stays the wiring's
// own word. web/src/runKinds.test.ts pins what those two lists contain.
const CONSUMER_KINDS: readonly string[] = RUN_FAMILY.consumer;
const TENANT_KINDS: readonly string[] = RUN_FAMILY.tenant;

// The full enable env for BOTH families — deliberately WITHOUT KUBECONFIG_PATH: the consumer gate
// is ONBOARD_GATE_CONTROLLER_ADDR + github, the tenant gate is the catalog write PAT. MASTER_*
// is part of the enable set for both, because both write onto the branch this installation keeps its
// books on and that branch is named after the cluster holding the master role.
const enabledEnv = {
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "controller",
  OIDC_CLIENT_SECRET: "s",
  CONTROLLER_VERSION: "test",
  LOG_LEVEL: "silent",
  ONBOARD_GATE_CONTROLLER_ADDR: "10.152.183.5:8484",
  GITHUB_REPO: "simetrixch/hostyour-cloud",
  GITHUB_WRITE_PAT: "ghp_platform",
  CATALOG_WRITE_PAT: "ghp_deploy",
  MASTER_FQDN: "m1.example.com",
  MASTER_SSH_USER: "m1",
  MASTER_STAGE: "prod",
} as NodeJS.ProcessEnv;

// The same minimal-but-valid kubeconfig document kube.test.ts uses — the KUBECONFIG_PATH variant
// loads it for REAL (loadFromFile parses + validates), proving the dev/test override end-to-end.
const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
current-context: test
clusters:
  - name: test
    cluster:
      server: https://kubeconfig-file.example:6443
contexts:
  - name: test
    context:
      cluster: test
      user: test
users:
  - name: test
    user:
      token: filetoken
`;

describe("buildOnboarding enable gates (wire-onboarding.ts)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // `undefined` in extraEnv REMOVES a key from the enabled base env (an empty string would fail
  // the min(1) schema of the optional enable vars — absent, not blank, is how a feature is off).
  function setup(extraEnv: Record<string, string | undefined> = {}): Parameters<typeof buildOnboarding> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-wireonb-"));
    dirs.push(dir);
    const config = parseConfig({ ...enabledEnv, DATA_DIR: dir, ...extraEnv } as NodeJS.ProcessEnv);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    const logger = createLogger(config);
    const store = new CredentialStore({ db: h.db, logger });
    return [config, store, h.db, logger];
  }

  it("enables BOTH families WITHOUT a kubeconfig — in-cluster (pod SA) is the default kube access", () => {
    const wiring = buildOnboarding(...setup());
    expect(wiring.enabled).toBe(true);
    expect(wiring.tenantEnabled).toBe(true);
    expect(wiring.defs.map((d) => d.kind).sort()).toEqual([...CONSUMER_KINDS, ...TENANT_KINDS].sort());
    // The tenant read routes' collaborators ride out with the family — the pointer registry is what the
    // orphan scan (GET /api/tenants/orphans) diffs the inventory against, and it must be the SAME
    // instance the tenant runs commit pointers through, never a second one.
    expect(wiring.tenantRegistry).toBeDefined();
    expect(wiring.appCatalog).toBeDefined();
    // The consumer twin: the Registry rides out so the detected scan
    // (GET /api/consumers/detected) diffs the very pointers the consumer runs commit.
    expect(wiring.registry).toBeDefined();
  });

  it("still honors a set KUBECONFIG_PATH as the explicit file override", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-wireonb-kc-"));
    dirs.push(dir);
    const file = join(dir, "kubeconfig.yaml");
    writeFileSync(file, KUBECONFIG_YAML, "utf8");
    const wiring = buildOnboarding(...setup({ KUBECONFIG_PATH: file }));
    expect(wiring.enabled).toBe(true);
    expect(wiring.tenantEnabled).toBe(true);
    expect(wiring.defs).toHaveLength(24); // 11 consumer (incl. purge, adopt-consumer, restart-workloads, set-size, backup/restore/migrate) + 13 tenant (those 12, plus check-tenants)
  });

  it("BOTH families stay off without MASTER_FQDN — nothing may write the books without knowing which branch they are", () => {
    // The books branch is the FQDN of the cluster holding the master role, and on a first boot the
    // configured value is the only statement of it: buildOnboarding runs BEFORE seedMaster writes
    // the row. Undecided, the only branch left to write registrations and cluster maps to would be
    // the trunk — which is where they came from, and where they belong to no installation and to
    // every future one at once. So the platform repo is not built at all, and the routes answer 501.
    const wiring = buildOnboarding(...setup({ MASTER_FQDN: undefined, MASTER_SSH_USER: undefined, MASTER_STAGE: undefined }));
    expect(wiring.enabled).toBe(false);
    expect(wiring.tenantEnabled).toBe(false);
    expect(wiring.platformRepo).toBeUndefined();
    expect(wiring.defs).toEqual([]);
  });

  it("hands BOTH repositories the same books branch — one installation, one books branch, two repos", () => {
    // The tenant registrations live in catalog and the consumer ones in hostyour-cloud, and the
    // branch carries the same name in both: the deploy repo takes it off the platform repo rather
    // than deriving it a second time, so the two cannot drift apart.
    const wiring = buildOnboarding(...setup());
    expect(wiring.platformRepo?.booksBranch).toBe("m1.example.com");
    expect(wiring.tenantRegistry?.branch).toBe("m1.example.com");
    expect(wiring.registry?.branch).toBe("m1.example.com");
  });

  it("consumer stays off without the gate-runner config; the tenant family is independent", () => {
    const wiring = buildOnboarding(...setup({ ONBOARD_GATE_CONTROLLER_ADDR: undefined }));
    expect(wiring.enabled).toBe(false);
    expect(wiring.tenantEnabled).toBe(true);
    expect(wiring.defs.map((d) => d.kind).sort()).toEqual([...TENANT_KINDS].sort());
    // No consumer family ⇒ no Registry, so the detected-scan route degrades to its reason
    // instead of scanning through a half-wired repo (the tenantRegistry twin below).
    expect(wiring.registry).toBeUndefined();
  });

  it("tenant stays off without the catalog write PAT; the consumer family is independent", () => {
    const wiring = buildOnboarding(...setup({ CATALOG_WRITE_PAT: undefined }));
    expect(wiring.enabled).toBe(true);
    expect(wiring.tenantEnabled).toBe(false);
    expect(wiring.defs.map((d) => d.kind).sort()).toEqual([...CONSUMER_KINDS].sort());
    // No family ⇒ no registry, so the orphan-scan route degrades to its reason instead of scanning
    // through a half-wired repo.
    expect(wiring.tenantRegistry).toBeUndefined();
  });

  it("returns the empty wiring when neither family is configured (routes answer 501)", () => {
    const wiring = buildOnboarding(...setup({ ONBOARD_GATE_CONTROLLER_ADDR: undefined, CATALOG_WRITE_PAT: undefined }));
    expect(wiring.enabled).toBe(false);
    expect(wiring.tenantEnabled).toBe(false);
    expect(wiring.defs).toHaveLength(0);
  });

  it("wires a REAL consumer-repo release-kit writer into the onboard def (https-only, not the fail-loud wiring gap)", async () => {
    // The release-kit writer is constructed in buildConsumerOnboarding and
    // injected into onboard. Prove it is the real GitConsumerRepo (not an absent port): production is
    // https-only, so running inject-release-kit against a file:// repoURL is rejected by the ADAPTER
    // ("must use https"), NOT by the step's own "none is wired" fail-loud guard.
    const wiring = buildOnboarding(...setup());
    const onboard = wiring.defs.find((d) => d.kind === "onboard")!;
    const step = onboard
      .steps({ consumerName: "acme", repoURL: "file:///tmp/x.git", repoCredentialId: "cred_pat" })
      .find((s) => s.name === "inject-release-kit")!;
    const ctx = { signal: new AbortController().signal, log: () => undefined, checkpoint: () => undefined } as unknown as StepCtx;
    await expect(step.run(ctx)).rejects.toThrow(/must use https/);
  });

  it("carries the remove-release-kit teardown step in the offboard + purge defs", () => {
    const wiring = buildOnboarding(...setup());
    for (const kind of ["offboard", "purge"]) {
      const def = wiring.defs.find((d) => d.kind === kind)!;
      const names = def.steps({ appId: "app_x", consumerName: "acme", stage: "prod", clusterId: "cls_1" }).map((s) => s.name);
      expect(names).toContain("remove-release-kit");
    }
  });
});
