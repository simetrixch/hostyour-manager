import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "./config.ts";

const validEnv = {
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.m1.example.com/application/o/manager/",
  OIDC_CLIENT_ID: "manager",
  OIDC_CLIENT_SECRET: "secret",
  MANAGER_VERSION: "test",
  DATA_DIR: "/data",
} as NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("derives redirectUri and cookieSecure from PUBLIC_URL", () => {
    const c = parseConfig(validEnv);
    expect(c.redirectUri).toBe("https://m1.example.com/auth/callback");
    expect(c.cookieSecure).toBe(true);
    expect(c.origin).toBe("https://m1.example.com");
    expect(c.dbFile.endsWith("controller.db")).toBe(true);
    expect(c.oidc.adminsGroup).toBe("admins");
    expect(c.port).toBe(8484);
    expect(c.emergencyPort).toBe(8485);
  });

  it("throws a named ConfigError naming the missing field", () => {
    const noUrl: NodeJS.ProcessEnv = { ...validEnv };
    delete noUrl.PUBLIC_URL;
    expect(() => parseConfig(noUrl)).toThrow(ConfigError);
    try {
      parseConfig(noUrl);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join(" ")).toContain("PUBLIC_URL");
    }
  });

  it("surfaces MANAGER_VERSION as version, and REQUIRES it (no silent default)", () => {
    expect(parseConfig({ ...validEnv, MANAGER_VERSION: "0.14.0" }).version).toBe("0.14.0");
    const noVer: NodeJS.ProcessEnv = { ...validEnv };
    delete noVer.MANAGER_VERSION;
    expect(() => parseConfig(noVer)).toThrow(ConfigError);
    try {
      parseConfig(noVer);
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).toContain("MANAGER_VERSION");
    }
  });

  it("defaults adminSocketMode to 0770 when ADMIN_SOCKET_MODE is absent", () => {
    // The one value that decides who may mint an operator session without a password. Absent means
    // the product's own boundary — the owning account plus the socket's group — and never a
    // deployment's mistake read as a choice.
    expect(parseConfig(validEnv).adminSocketMode).toBe(0o770);
  });

  it("reads ADMIN_SOCKET_MODE as OCTAL, with or without the leading zero", () => {
    // A file mode is written octal. Read as decimal, "700" would be 0o1274 — a mode that still
    // looks plausible in a values file and grants a different set of accounts.
    expect(parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: "0700" }).adminSocketMode).toBe(0o700);
    expect(parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: "770" }).adminSocketMode).toBe(0o770);
    expect(parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: "777" }).adminSocketMode).toBe(0o777);
    expect(parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: "000" }).adminSocketMode).toBe(0);
  });

  it("refuses an ADMIN_SOCKET_MODE that is not an octal file mode", () => {
    for (const bad of ["", "8", "0778", "rwx", "0o770", "70", "07700"]) {
      expect(() => parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: bad }), `accepted ${JSON.stringify(bad)}`).toThrow(ConfigError);
    }
    try {
      parseConfig({ ...validEnv, ADMIN_SOCKET_MODE: "0778" });
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).toContain("ADMIN_SOCKET_MODE");
    }
  });

  it("cookieSecure is false behind an http PUBLIC_URL", () => {
    const c = parseConfig({ ...validEnv, PUBLIC_URL: "http://localhost:8484" });
    expect(c.cookieSecure).toBe(false);
    expect(c.redirectUri).toBe("http://localhost:8484/auth/callback");
  });

  it("leaves kubeconfigPath ABSENT when KUBECONFIG_PATH is unset or empty (in-cluster is the default)", () => {
    // No falsy sentinel: the kube adapters branch on presence (kube.ts buildKubeConfig), and a
    // deployment that templates the var to "" must mean the same as not setting it at all.
    expect(parseConfig(validEnv).kubeconfigPath).toBeUndefined();
    expect(parseConfig({ ...validEnv, KUBECONFIG_PATH: "" }).kubeconfigPath).toBeUndefined();
  });

  it("carries KUBECONFIG_PATH through as the explicit dev/test file override when set", () => {
    expect(parseConfig({ ...validEnv, KUBECONFIG_PATH: "/tmp/kubeconfig" }).kubeconfigPath).toBe("/tmp/kubeconfig");
  });
});

describe("tenant onboarding config (catalog)", () => {
  it("leaves catalog absent when CATALOG_WRITE_PAT is unset (the write PAT is the discriminator)", () => {
    expect(parseConfig(validEnv).catalog).toBeUndefined();
    // The repo default alone does NOT enable it — without the PAT there is nothing to wire.
    expect(parseConfig({ ...validEnv, CATALOG_REPO: "simetrixch/catalog" }).catalog).toBeUndefined();
  });

  it("builds the catalog repoURL from the default repo when only the PAT is set", () => {
    const c = parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant" });
    expect(c.catalog).toEqual({ repoURL: "https://github.com/simetrixch/catalog.git", token: "ghp_tenant" });
  });

  it("honors a custom CATALOG_REPO", () => {
    const c = parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant", CATALOG_REPO: "acme/deploy" });
    expect(c.catalog?.repoURL).toBe("https://github.com/acme/deploy.git");
  });

  it("rejects a malformed CATALOG_REPO", () => {
    expect(() => parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant", CATALOG_REPO: "not-a-repo" })).toThrow(ConfigError);
  });

  it("is independent of the consumer gate-runner (tenant charts validate manager-side)", () => {
    const c = parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant" });
    expect(c.catalog).toBeDefined();
    expect(c.onboarding).toBeUndefined(); // no ONBOARD_GATE_MANAGER_ADDR, yet tenant config still resolves
  });
});

describe("consumer build webhook config", () => {
  it("defaults the EventListener subdomain to 'build' and leaves the HMAC secret absent in dev", () => {
    const c = parseConfig(validEnv);
    expect(c.webhook.subdomain).toBe("build");
    expect(c.webhook.secret).toBeUndefined(); // absent ⇒ the onboard setup-webhook step fails loud
  });

  it("carries GITHUB_WEBHOOK_SECRET through as the HMAC secret when set", () => {
    const c = parseConfig({ ...validEnv, GITHUB_WEBHOOK_SECRET: "hmac_shared" });
    expect(c.webhook).toEqual({ subdomain: "build", secret: "hmac_shared" });
  });

  it("honors a custom BUILD_EVENTLISTENER_SUBDOMAIN override", () => {
    expect(parseConfig({ ...validEnv, BUILD_EVENTLISTENER_SUBDOMAIN: "ci" }).webhook.subdomain).toBe("ci");
  });
});

describe("Vault backend config", () => {
  it("stays absent without VAULT_ADDR — the local keystore path (dev/tests)", () => {
    expect(parseConfig(validEnv).vault).toBeUndefined();
  });

  it("REQUIRES VAULT_K8S_AUTH_MOUNT alongside VAULT_ADDR — the mount is named after the cluster", () => {
    // No default is possible: the auth mount is kubernetes-<cluster> and exists on no other cluster,
    // so a defaulted value would send every login to a mount that is not there.
    expect(() => parseConfig({ ...validEnv, VAULT_ADDR: "https://vault.m1.example:8200" })).toThrow(ConfigError);
    try {
      parseConfig({ ...validEnv, VAULT_ADDR: "https://vault.m1.example:8200" });
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).toContain("VAULT_K8S_AUTH_MOUNT");
    }
  });

  it("resolves the Vault surface when both are set", () => {
    const c = parseConfig({ ...validEnv, VAULT_ADDR: "https://vault.m1.example:8200", VAULT_K8S_AUTH_MOUNT: "kubernetes-m1" });
    expect(c.vault).toEqual({
      addr: "https://vault.m1.example:8200",
      k8sRole: "manager",
      kvPrefix: "controller/cred",
      k8sAuthMount: "kubernetes-m1",
      saTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    });
  });
});
