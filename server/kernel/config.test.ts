import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError, MAX_SOCKET_PATH_BYTES } from "./config.ts";

const validEnv = {
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.m1.example.com/application/o/manager/",
  OIDC_CLIENT_ID: "manager",
  OIDC_CLIENT_SECRET: "secret",
  MANAGER_VERSION: "test",
  DATA_DIR: "/data",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
} as NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("derives redirectUri and cookieSecure from PUBLIC_URL", () => {
    const c = parseConfig(validEnv);
    expect(c.redirectUri).toBe("https://m1.example.com/auth/callback");
    expect(c.cookieSecure).toBe(true);
    expect(c.origin).toBe("https://m1.example.com");
    expect(c.dbFile.endsWith("manager.db")).toBe(true);
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

  it("carries ADMIN_SOCKET_PATH through, and REQUIRES it (the deployment names the mount, not this repo)", () => {
    expect(parseConfig(validEnv).adminSocketPath).toBe("/run/manager/admin.sock");
    const noPath: NodeJS.ProcessEnv = { ...validEnv };
    delete noPath.ADMIN_SOCKET_PATH;
    expect(() => parseConfig(noPath)).toThrow(ConfigError);
    try {
      parseConfig(noPath);
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).toContain("ADMIN_SOCKET_PATH");
    }
  });

  it("refuses an ADMIN_SOCKET_PATH a UNIX socket cannot stand on, and says by how much", () => {
    // The measured shape: a data claim the storage provisioner placed at
    // /var/snap/microk8s/common/default-storage/<namespace>-<claim>-<uid>/admin.sock, 114 bytes,
    // where bind(2) and connect(2) both answer ENAMETOOLONG. Refused at boot, naming the byte
    // count, rather than surfacing as a refused connect in whatever runs first.
    const overflowing = "/var/snap/microk8s/common/default-storage/manager-manager-data-pvc-90579cab-ae9d-48a3-aaaf-e4fe2d8ff503/admin.sock";
    expect(Buffer.byteLength(overflowing, "utf8")).toBe(114);
    expect(() => parseConfig({ ...validEnv, ADMIN_SOCKET_PATH: overflowing })).toThrow(ConfigError);
    try {
      parseConfig({ ...validEnv, ADMIN_SOCKET_PATH: overflowing });
    } catch (e) {
      const said = (e as ConfigError).issues.join(" ");
      expect(said).toContain("ADMIN_SOCKET_PATH");
      expect(said).toContain("114");
      expect(said).toContain(String(MAX_SOCKET_PATH_BYTES));
    }
  });

  it("accepts a path of exactly MAX_SOCKET_PATH_BYTES, and refuses the next byte", () => {
    // The boundary itself, from both sides: sun_path is 108 bytes and the terminating NUL takes
    // one, so 107 fit and 108 do not. An off-by-one either way is a limit nobody measured.
    const atLimit = `/run/${"a".repeat(MAX_SOCKET_PATH_BYTES - "/run/".length)}`;
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_SOCKET_PATH_BYTES);
    expect(parseConfig({ ...validEnv, ADMIN_SOCKET_PATH: atLimit }).adminSocketPath).toBe(atLimit);
    expect(() => parseConfig({ ...validEnv, ADMIN_SOCKET_PATH: `${atLimit}a` })).toThrow(ConfigError);
  });

  it("counts ADMIN_SOCKET_PATH in BYTES, not in characters — the kernel copies bytes into sun_path", () => {
    // A path of non-ASCII characters is shorter in characters than in bytes, and it is the bytes
    // the kernel has room for. Measuring length in characters would accept a path that overflows.
    const twoBytesEach = `/run/${"ä".repeat(60)}`; // 65 characters, 125 bytes
    expect(twoBytesEach.length).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(twoBytesEach, "utf8")).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(() => parseConfig({ ...validEnv, ADMIN_SOCKET_PATH: twoBytesEach })).toThrow(ConfigError);
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

  it("leaves platformUnitName ABSENT without PLATFORM_UNIT_NAME, and REFUSES an empty one by name", () => {
    // ABSENT closes the one branch that skips the gate (domains/units/first-master.ts), which is the
    // safe direction and the state of every Manager that does not install first masters.
    expect(parseConfig(validEnv).platformUnitName).toBeUndefined();
    expect(parseConfig({ ...validEnv, PLATFORM_UNIT_NAME: "hostyour-manager" }).platformUnitName).toBe("hostyour-manager");

    // AN EMPTY VALUE IS NOT THE ABSENT ONE, and the difference decides whether an installation can
    // onboard its own manager. A deployment that templated the variable from a key somebody left
    // empty must STOP the Manager and name the variable, not quietly close the branch its own
    // installer needs — an operator would then watch the last program of a first master fail at a
    // gate nobody asked for, with nothing anywhere saying why.
    expect(() => parseConfig({ ...validEnv, PLATFORM_UNIT_NAME: "" })).toThrow(ConfigError);
    try {
      parseConfig({ ...validEnv, PLATFORM_UNIT_NAME: "" });
    } catch (e) {
      expect((e as ConfigError).issues.join(" ")).toContain("PLATFORM_UNIT_NAME");
    }
    // A name that is not a unit name is refused the same way — the word has to be the one the
    // manifest and the onboarding request already carry, and neither can be an upper-case string
    // or a path.
    expect(() => parseConfig({ ...validEnv, PLATFORM_UNIT_NAME: "Hostyour-Manager" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...validEnv, PLATFORM_UNIT_NAME: "hostyour/manager" })).toThrow(ConfigError);
  });
});

describe("tenant onboarding config (catalog)", () => {
  it("leaves catalog absent when neither half is set", () => {
    expect(parseConfig(validEnv).catalog).toBeUndefined();
  });

  it("refuses each half without the other, because a catalogue nobody named is not a catalogue", () => {
    // The repository is the INSTALLATION's own and has no default: one that binds a whole tenant
    // family to a repository nobody chose is worse than a refusal, because a clone that SUCCEEDS
    // against the wrong repository says nothing at all.
    expect(() => parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...validEnv, CATALOG_REPO: "acme/acme-catalog" })).toThrow(ConfigError);
  });

  it("honors a custom CATALOG_REPO", () => {
    const c = parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant", CATALOG_REPO: "acme/deploy" });
    expect(c.catalog?.repoURL).toBe("https://github.com/acme/deploy.git");
  });

  it("rejects a malformed CATALOG_REPO", () => {
    expect(() => parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant", CATALOG_REPO: "not-a-repo" })).toThrow(ConfigError);
  });

  it("is independent of the consumer gate-runner (tenant charts validate manager-side)", () => {
    const c = parseConfig({ ...validEnv, CATALOG_WRITE_PAT: "ghp_tenant", CATALOG_REPO: "acme/acme-catalog" });
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
      kvPrefix: "manager/cred",
      k8sAuthMount: "kubernetes-m1",
      saTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    });
  });

  it("lets VAULT_KV_PREFIX override the compiled default — the prefix is a surface, not a constant", () => {
    // Nothing sets this variable in the cluster today, so the default above is the address the live
    // entries stand under. That is a property of the deployment, not of this schema: a deployment
    // that moves its credentials must be able to point the store at where they went.
    const c = parseConfig({
      ...validEnv,
      VAULT_ADDR: "https://vault.m1.example:8200",
      VAULT_K8S_AUTH_MOUNT: "kubernetes-m1",
      VAULT_KV_PREFIX: "elsewhere/cred",
    });
    expect(c.vault?.kvPrefix).toBe("elsewhere/cred");
  });
});
