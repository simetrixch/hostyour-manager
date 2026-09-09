// gate-runner/src/gates/secret-contract.gate.test.ts
// One clean-context PASS plus a dedicated FAIL per failure mode of G7 "secret contract":
//   1. an ExternalSecret referencing a property not declared in manifest.secrets,
//   2. a SecretStore whose server != the cluster chain's global.endpoints.vault.url (a hardcoded literal),
//   3. an ExternalSecret with a wrong remoteRef.key,
//   4. a null manifest,
//   5. a ClusterExternalSecret (spec.externalSecretSpec) with an undeclared remoteRef.property,
//   6. a ClusterExternalSecret with a wrong remoteRef.key,
//   7. a SecretStore naming no serviceAccountRef,
//   8. a ServiceAccount missing one of the two alias-metadata annotations,
//   9. a ServiceAccount claiming another unit,
//   plus a PASS for a well-formed ClusterExternalSecret referencing a declared key.
// Each FAIL asserts BOTH status === "fail" and that `reason` names the specific problem.
import { describe, expect, it } from "vitest";
import type { GateContext, RenderedDoc } from "./gate.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import { chainVaultServer, secretContractGate } from "./secret-contract.gate.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const VAULT_SERVER = "https://vault.svc.cluster.local:8200";
const EXPECTED_KEY = "test/consumer/acme/app"; // <stage>/consumer/<name>/app

// The cluster's values chain as the gate receives it: the per-stage file carries global.endpoints.vault.url and
// the profile loads LAST, so the profile's value is the one G7 must hold the render against.
const CHAIN: ClusterValueFile[] = [
  { path: "clusters/platform/values-common.yaml", content: "global:\n  clusterIssuer: platform-acme\n" },
  { path: "clusters/platform/values-test.yaml", content: "global:\n  env: test\n  endpoints:\n    vault:\n      url: https://vault.elsewhere:8200\n" },
  { path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    vault:\n      url: ${VAULT_SERVER}\n` },
];

function baseManifest(): ConsumerManifest {
  return {
    apiVersion: "hostyour.cloud/v1",
    kind: "ConsumerManifest", mongodb: "shared" as const,
    name: "acme",
    owner: "team-acme",
    envs: ["test"],
    chart: { path: "deploy/chart" },
    services: [],
    databases: [],
    builds: [],
    secrets: [
      { key: "DB_PASSWORD", required: true },
      { key: "API_TOKEN", required: true },
    ],
  };
}

function secretStore(over?: { server?: string; role?: string; serviceAccount?: string | null }): RenderedDoc {
  const serviceAccountRef = over?.serviceAccount === null ? {} : { serviceAccountRef: { name: over?.serviceAccount ?? "acme" } };
  return {
    env: "test",
    docIndex: 0,
    apiVersion: "external-secrets.io/v1beta1",
    kind: "SecretStore",
    name: "acme",
    namespace: "acme-test",
    raw: {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "SecretStore",
      metadata: { name: "acme", namespace: "acme-test" },
      spec: {
        provider: {
          vault: {
            server: over?.server ?? VAULT_SERVER,
            path: "secret",
            auth: { kubernetes: { mountPath: "kubernetes", role: over?.role ?? "consumer-eso", ...serviceAccountRef } },
          },
        },
      },
    },
  };
}

/** The ServiceAccount the store logs in as. Vault's `consumer-eso` role lifts these two annotations
 *  into the alias metadata its policy path <stage>/consumer/<unit>/* is templated on, so the chart
 *  must render them on exactly this object — `null` leaves one out. */
function serviceAccount(over?: { unit?: string | null; stage?: string | null }): RenderedDoc {
  const unit = over?.unit === undefined ? "acme" : over.unit;
  const stage = over?.stage === undefined ? "test" : over.stage;
  return {
    env: "test",
    docIndex: 3,
    apiVersion: "v1",
    kind: "ServiceAccount",
    name: "acme",
    namespace: "acme-test",
    raw: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: "acme",
        namespace: "acme-test",
        annotations: {
          ...(unit !== null ? { "vault.hashicorp.com/alias-metadata-unit": unit } : {}),
          ...(stage !== null ? { "vault.hashicorp.com/alias-metadata-stage": stage } : {}),
        },
      },
    },
  };
}

function externalSecret(over?: { key?: string; property?: string; refreshPolicy?: string | null }): RenderedDoc {
  const key = over?.key ?? EXPECTED_KEY;
  // A well-formed document carries the platform's delivery rule. `refreshPolicy: null` takes it
  // away entirely, which is the DANGEROUS shape — absent means the controller's Periodic default.
  const policy = over && "refreshPolicy" in over ? over.refreshPolicy : "OnChange";
  return {
    env: "test",
    docIndex: 1,
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ExternalSecret",
    name: "acme",
    namespace: "acme",
    raw: {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: "acme", namespace: "acme" },
      spec: {
        ...(policy === null ? {} : { refreshPolicy: policy }),
        refreshInterval: "0",
        data: [
          { secretKey: "DB_PASSWORD", remoteRef: { key, property: over?.property ?? "DB_PASSWORD" } },
          { secretKey: "API_TOKEN", remoteRef: { key, property: "API_TOKEN" } },
        ],
        dataFrom: [{ extract: { key } }],
      },
    },
  };
}

// Cluster-scoped sibling: the identical ExternalSecret read spec sits one level deeper under
// spec.externalSecretSpec, plus a namespaceSelector that fans the resulting Secret into arbitrary
// namespaces. It must clear the same key + declared-property checks as an ExternalSecret.
function clusterExternalSecret(over?: { key?: string; property?: string; refreshPolicy?: string | null }): RenderedDoc {
  const key = over?.key ?? EXPECTED_KEY;
  const policy = over && "refreshPolicy" in over ? over.refreshPolicy : "OnChange";
  return {
    env: "test",
    docIndex: 2,
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ClusterExternalSecret",
    name: "acme",
    namespace: "",
    raw: {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ClusterExternalSecret",
      metadata: { name: "acme" },
      spec: {
        namespaceSelector: { matchLabels: { team: "acme" } },
        externalSecretSpec: {
          ...(policy === null ? {} : { refreshPolicy: policy }),
          refreshInterval: "0",
          data: [
            { secretKey: "DB_PASSWORD", remoteRef: { key, property: over?.property ?? "DB_PASSWORD" } },
            { secretKey: "API_TOKEN", remoteRef: { key, property: "API_TOKEN" } },
          ],
          dataFrom: [{ extract: { key } }],
        },
      },
    },
  };
}

function makeCtx(over: Partial<GateContext> = {}): GateContext {
  return {
    targetName: "acme",
    stage: "test",
    chartPath: "deploy/chart",
    clusterValueFiles: CHAIN,
    files: new Map<string, string>(),
    manifest: baseManifest(),
    rendered: [secretStore(), externalSecret(), serviceAccount()],
    dependencies: [],
    ...over,
  };
}

describe("G7 secret contract", () => {
  it("passes a clean SecretStore + ExternalSecret against the cluster's single-Vault contract", () => {
    const r = secretContractGate.check(makeCtx());
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
    expect(r.severity).toBe("hard");
  });

  it("ignores rendered docs from OTHER envs — scopes to the onboarding stage (multi-env render)", () => {
    // The chart renders per declared env (G3 kubeconform coverage), so ctx.rendered also carries the
    // dev/prod ExternalSecrets whose remoteRef.key embeds THEIR stage. With onboarding stage "test",
    // those dev-env docs (key dev/consumer/acme/app) must NOT be flagged against test/consumer/acme/app.
    const devEs: RenderedDoc = {
      env: "dev",
      docIndex: 3,
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      name: "acme",
      namespace: "acme",
      raw: {
        apiVersion: "external-secrets.io/v1beta1",
        kind: "ExternalSecret",
        metadata: { name: "acme", namespace: "acme" },
        spec: {
          data: [
            { secretKey: "DB_PASSWORD", remoteRef: { key: "dev/consumer/acme/app", property: "DB_PASSWORD" } },
            { secretKey: "API_TOKEN", remoteRef: { key: "dev/consumer/acme/app", property: "API_TOKEN" } },
          ],
          dataFrom: [{ extract: { key: "dev/consumer/acme/app" } }],
        },
      },
    };
    const devStore: RenderedDoc = { ...secretStore(), env: "dev", docIndex: 2 };
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret(), serviceAccount(), devStore, devEs] }));
    expect(r.status).toBe("pass"); // the dev/... keys are out of scope, not violations
    expect(r.reason).toBeNull();
    expect(r.found).toContain("onboarding stage");
  });

  it("notes declared-but-unreferenced manifest keys as advisory, still passing", () => {
    const manifest = baseManifest();
    manifest.secrets.push({ key: "UNUSED_KEY", required: true });
    const r = secretContractGate.check(makeCtx({ manifest }));
    expect(r.status).toBe("pass");
    expect(r.found).toContain("UNUSED_KEY");
  });

  it("FAIL 1: an ExternalSecret referencing a property not in manifest.secrets", () => {
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret({ property: "SECRET_XYZ" })] }));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("SECRET_XYZ");
    expect(r.reason).toContain("not declared");
  });

  it("FAIL 2: a SecretStore server != the cluster chain's global.endpoints.vault.url (hardcoded literal)", () => {
    const badServer = "https://evil.attacker.example:8200";
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore({ server: badServer }), externalSecret()] }));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain(badServer);
    expect(r.reason).toContain(VAULT_SERVER);
  });

  it("FAIL 3: an ExternalSecret with a wrong remoteRef.key", () => {
    const wrongKey = "prod/consumer/acme/app";
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret({ key: wrongKey })] }));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain(wrongKey);
    expect(r.reason).toContain(EXPECTED_KEY);
  });

  it("FAIL 4: a null manifest cannot validate secret references", () => {
    const r = secretContractGate.check(makeCtx({ manifest: null }));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("manifest");
  });

  it("also fails a SecretStore whose auth role is not consumer-eso", () => {
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore({ role: "admin" }), externalSecret()] }));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("consumer-eso");
  });

  it("FAIL 5: a ClusterExternalSecret whose remoteRef.property is not in manifest.secrets", () => {
    const r = secretContractGate.check(
      makeCtx({ rendered: [secretStore(), clusterExternalSecret({ property: "SECRET_XYZ" })] }),
    );
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("SECRET_XYZ");
    expect(r.reason).toContain("not declared");
  });

  it("FAIL 6: a ClusterExternalSecret with a wrong remoteRef.key", () => {
    const wrongKey = "prod/consumer/acme/app";
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), clusterExternalSecret({ key: wrongKey })] }));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain(wrongKey);
    expect(r.reason).toContain(EXPECTED_KEY);
  });

  it("FAIL 7: a SecretStore that names no serviceAccountRef — nothing carries the unit and stage the login is bound by", () => {
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore({ serviceAccount: null }), externalSecret(), serviceAccount()] }));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("serviceAccountRef");
  });

  it("FAIL 8: the ServiceAccount misses one of the two alias-metadata annotations", () => {
    for (const missing of [{ stage: null }, { unit: null }] as const) {
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret(), serviceAccount(missing)] }));
      expect(r.status, JSON.stringify(missing)).toBe("fail");
      expect(r.reason).toContain("stage" in missing ? "vault.hashicorp.com/alias-metadata-stage" : "vault.hashicorp.com/alias-metadata-unit");
    }
  });

  it("FAIL 9: the ServiceAccount claims another unit or another stage — that is another entry of the mount", () => {
    for (const foreign of [{ unit: "other" }, { stage: "prod" }] as const) {
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret(), serviceAccount(foreign)] }));
      expect(r.status, JSON.stringify(foreign)).toBe("fail");
      expect(r.reason).toContain("unit" in foreign ? "other" : "prod");
    }
  });

  describe("the platform's secret delivery rule", () => {
    // Until this check existed, the FIRST thing to judge a consumer's ExternalSecret was the
    // cluster's own externalsecret-delivery admission policy — mid-onboarding, with the namespace
    // already applied, the object refused and the app Secret missing. Three consumer charts carried
    // the defect at once (digitaplatform/digita-auth#6 and its siblings).
    it("refuses an ExternalSecret that names NO refreshPolicy, which is the shape that silently polls", () => {
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret({ refreshPolicy: null }), serviceAccount()] }));
      expect(r.status).toBe("fail");
      // The message has to say ABSENT rather than "wrong value": an absent field is not an empty
      // one, it is the controller's Periodic default, and that is what nobody notices.
      expect(r.reason).toMatch(/refreshPolicy is absent, so the controller's Periodic default applies/);
      expect(r.reason).toMatch(/must be "OnChange"/);
    });

    it("refuses an ExternalSecret carrying a DIFFERENT policy, and names the value it found", () => {
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret({ refreshPolicy: "Periodic" }), serviceAccount()] }));
      expect(r.status).toBe("fail");
      expect(r.reason).toMatch(/refreshPolicy is "Periodic"/);
    });

    it("holds the cluster-scoped sibling to the same rule, one level deeper", () => {
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), externalSecret(), clusterExternalSecret({ refreshPolicy: null })] }));
      expect(r.status).toBe("fail");
      expect(r.reason).toMatch(/spec\.externalSecretSpec\.refreshPolicy is absent/);
    });

    it("does NOT refuse over refreshInterval — the cluster does not hold it either", () => {
      // The counter-probe of the three above, and the reason it exists: the admission policy holds
      // refreshPolicy alone and says so in as many words, because under OnChange a document has no
      // timer whatever the interval says. A gate refusing more than the cluster would refuse a
      // document the cluster accepts, which the consumer could then never make pass.
      const doc = externalSecret();
      (doc.raw.spec as Record<string, unknown>).refreshInterval = "1h";
      const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), doc, serviceAccount()] }));
      expect(r.status).toBe("pass");
    });
  });

  it("passes a well-formed ClusterExternalSecret referencing a declared key at spec.externalSecretSpec", () => {
    const r = secretContractGate.check(makeCtx({ rendered: [secretStore(), clusterExternalSecret(), serviceAccount()] }));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
    expect(r.severity).toBe("hard");
  });

  it("does not crash on a hostile malformed rendered doc (string where an object is expected)", () => {
    const hostileStore: RenderedDoc = {
      env: "test",
      docIndex: 0,
      apiVersion: "external-secrets.io/v1beta1",
      kind: "SecretStore",
      name: "acme",
      namespace: "acme",
      raw: { spec: "not-an-object" },
    };
    const hostileEs: RenderedDoc = {
      env: "test",
      docIndex: 1,
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      name: "acme",
      namespace: "acme",
      raw: { spec: { data: "nope", dataFrom: 42 } },
    };
    const r = secretContractGate.check(makeCtx({ rendered: [hostileStore, hostileEs] }));
    expect(r.status).toBe("fail"); // missing server + absent role are still caught
    expect(r.reason).toContain("consumer-eso");
  });
});

describe("chainVaultServer", () => {
  it("takes the LAST file that sets global.endpoints.vault.url — installation/profile.yaml wins over the stage file", () => {
    expect(chainVaultServer(CHAIN)).toBe(VAULT_SERVER);
  });

  it("fails the gate when no file of the chain sets global.endpoints.vault.url", () => {
    const noVault = [{ path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" }];
    expect(chainVaultServer(noVault)).toBeNull();
    const r = secretContractGate.check(makeCtx({ clusterValueFiles: noVault }));
    expect(r.status).toBe("fail");
    expect(r.found).toContain("global.endpoints.vault.url");
    expect(r.reason).toContain("Vault URL");
  });
});
