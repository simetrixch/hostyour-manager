import { describe, it, expect } from "vitest";
import { seedQuota } from "./unit-size.ts";
import { consumerArgoAppName, consumerArgocdUrl, ConsumerManifestSchema, ConsumerRegistrationSchema } from "./consumer.ts";

describe("ConsumerManifestSchema activation block", () => {
  const base = {
    apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const, name: "acme", owner: "team-acme",
    envs: ["prod"], chart: { path: "deploy/chart" }, services: [], builds: [],
    secrets: [{ key: "AUTH_BOOTSTRAP_TOKEN", required: true, generate: "hex32" }],
  } as const;
  const activation = { path: "/api/v1/bootstrap/invite-admin", method: "POST", tokenSecret: "AUTH_BOOTSTRAP_TOKEN", tokenHeader: "X-Bootstrap-Token", prompt: [{ field: "email", label: "Admin email" }] };

  it("accepts a well-formed activation whose tokenSecret names a declared required secret", () => {
    const r = ConsumerManifestSchema.safeParse({ ...base, activation });
    expect(r.success).toBe(true);
  });

  it("is backward-compatible: a manifest with NO activation parses unchanged (activation undefined)", () => {
    const r = ConsumerManifestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.activation).toBeUndefined();
  });

  it("rejects a tokenSecret that names no declared secret (dangling reference)", () => {
    const r = ConsumerManifestSchema.safeParse({ ...base, activation: { ...activation, tokenSecret: "NOPE" } });
    expect(r.success).toBe(false);
  });

  it("rejects a tokenSecret that names an OPTIONAL secret (it may be unseeded)", () => {
    const r = ConsumerManifestSchema.safeParse({
      ...base, secrets: [{ key: "AUTH_BOOTSTRAP_TOKEN", required: false, generate: "hex32" }], activation,
    });
    expect(r.success).toBe(false);
  });

  it("rejects duplicate prompt field names and a non-absolute path", () => {
    expect(ConsumerManifestSchema.safeParse({ ...base, activation: { ...activation, prompt: [{ field: "email", label: "A" }, { field: "email", label: "B" }] } }).success).toBe(false);
    expect(ConsumerManifestSchema.safeParse({ ...base, activation: { ...activation, path: "bootstrap" } }).success).toBe(false);
  });
});

describe("ConsumerManifestSchema deploy requirement (C1: chart | builds[] | tenant)", () => {
  const meta = { apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const, name: "hostyour", owner: "platform", envs: ["prod"] } as const;
  const tenantBlock = {
    members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }, { name: "jobs", chart: "charts/example-jobs" }, { name: "report", chart: "charts/example-report" }],
    perApp: {
      engine: { chart: "charts/example-engine" },
      front: { chart: "charts/example-ui", override: { web: { chart: "charts/example-web" } } },
    },
  };

  it("accepts a PURE tenant fan-out manifest — no chart, no builds, only a tenant: block (catalog's shape)", () => {
    const r = ConsumerManifestSchema.safeParse({ ...meta, tenant: tenantBlock });
    expect(r.success).toBe(true);
  });

  it("rejects a manifest that declares neither chart, builds[], nor tenant (inert)", () => {
    expect(ConsumerManifestSchema.safeParse({ ...meta }).success).toBe(false);
  });

  it("still rejects a tenant fan-out that also declares its own chart (C4)", () => {
    expect(ConsumerManifestSchema.safeParse({ ...meta, chart: { path: "deploy/chart" }, tenant: tenantBlock }).success).toBe(false);
  });
});

describe("ConsumerManifestSchema databases (DB-name contract, sibling of services)", () => {
  const base = {
    apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const, name: "acme", owner: "team-acme",
    envs: ["prod"], chart: { path: "deploy/chart" },
  } as const;

  it("defaults databases to [] when the manifest omits it (backward-compatible)", () => {
    const r = ConsumerManifestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.databases).toEqual([]);
  });

  it("carries the literal DB name(s) VERBATIM — no prefix, no env-suffix, no composition", () => {
    const r = ConsumerManifestSchema.safeParse({ ...base, databases: ["example_auth"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.databases).toEqual(["example_auth"]);
  });
});

describe("ConsumerManifestSchema fqdn (the declared extra public FQDN)", () => {
  const base = {
    apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const, name: "acme", owner: "team-acme",
    envs: ["prod"], chart: { path: "deploy/chart" },
  } as const;

  it("accepts a lowercase multi-label FQDN and stays undefined when absent (backward-compatible)", () => {
    const declared = ConsumerManifestSchema.safeParse({ ...base, fqdn: "shop.example.org" });
    expect(declared.success).toBe(true);
    if (declared.success) expect(declared.data.fqdn).toBe("shop.example.org");
    const absent = ConsumerManifestSchema.safeParse(base);
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.fqdn).toBeUndefined();
  });

  it("rejects a bare label, uppercase, and CEL-hostile characters — the grammar is what keeps the value safe to inline into the admission policy", () => {
    for (const fqdn of ["shop", "Shop.example.org", "shop.example.org'", "shop_x.example.org"]) {
      expect(ConsumerManifestSchema.safeParse({ ...base, fqdn }).success).toBe(false);
    }
  });

  it("rejects fqdn on a manifest without a chart — a build-only or fan-out unit has no Ingress of its own to serve it", () => {
    const r = ConsumerManifestSchema.safeParse({ ...base, chart: undefined, builds: [{ name: "acme-api", containerfile: "Containerfile" }], fqdn: "shop.example.org" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join(".") === "fqdn")).toBe(true);
  });
});

describe("ConsumerRegistrationSchema fqdn (the ATTESTED extra FQDN)", () => {
  const stage = {
    name: "acme", repoURL: "https://github.com/x/acme.git",
    chartPath: "deploy/chart", cluster: "s1", databases: [] as string[], services: [] as string[], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"),
  };

  it("is OPTIONAL in the stage form — outside the deploy group's stands-or-falls rule", () => {
    expect(ConsumerRegistrationSchema.safeParse(stage).success).toBe(true);
    const attested = ConsumerRegistrationSchema.safeParse({ ...stage, fqdn: "shop.example.org" });
    expect(attested.success).toBe(true);
    if (attested.success) expect(attested.data.fqdn).toBe("shop.example.org");
  });

  it("refuses fqdn in a build registration — build.yaml describes no serving surface", () => {
    const r = ConsumerRegistrationSchema.safeParse({ name: "acme", repoURL: "https://github.com/x/acme.git", builds: [], fqdn: "shop.example.org" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("stage registration");
  });
});

describe("ConsumerRegistrationSchema databases (verbatim copy carried in the registration)", () => {
  const stage = {
    name: "acme", repoURL: "https://github.com/x/acme.git",
    chartPath: "deploy/chart", cluster: "s1", databases: [] as string[], services: [] as string[], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"),
  };

  it("requires databases[] in a stage registration — the whole deploy group stands together", () => {
    const { databases: _drop, ...withoutDatabases } = stage;
    const r = ConsumerRegistrationSchema.safeParse(withoutDatabases);
    expect(r.success).toBe(false);
  });

  it("carries the literal DB name(s) VERBATIM — the single source of truth flows into the registration", () => {
    const r = ConsumerRegistrationSchema.safeParse({ ...stage, databases: ["example_auth"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.databases).toEqual(["example_auth"]);
  });
});

describe("ConsumerRegistrationSchema services (the per-consumer postgres switch carried in the registration)", () => {
  const stage = {
    name: "acme", repoURL: "https://github.com/x/acme.git",
    chartPath: "deploy/chart", cluster: "s1", databases: [] as string[], services: [] as string[], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"),
  };

  it("requires services[] in a stage registration (empty is fine) — a chart source gates on it bare", () => {
    const { services: _drop, ...withoutServices } = stage;
    const r = ConsumerRegistrationSchema.safeParse(withoutServices);
    expect(r.success).toBe(false);
  });

  it("carries a postgresql claim VERBATIM (the switch the appset gates the per-consumer postgres source on)", () => {
    const r = ConsumerRegistrationSchema.safeParse({ ...stage, services: ["postgresql"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.services).toEqual(["postgresql"]);
  });

  it("rejects a service outside the CONSUMER_SERVICE vocabulary (the enum is the contract)", () => {
    const r = ConsumerRegistrationSchema.safeParse({ ...stage, services: ["not-a-service"] });
    expect(r.success).toBe(false);
  });
});

describe("ConsumerRegistrationSchema field-level exclusivity (the deploy group vs. a build registration)", () => {
  const buildOnly = { name: "acme", repoURL: "https://github.com/x/acme.git", builds: ["acme-backend"] };
  const stage = {
    name: "acme", repoURL: "https://github.com/x/acme.git",
    chartPath: "deploy/chart", cluster: "s1", databases: [] as string[], services: [] as string[], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"),
  };

  it("accepts a build registration (no deploy group, builds[] present)", () => {
    expect(ConsumerRegistrationSchema.safeParse(buildOnly).success).toBe(true);
  });

  it("rejects a build registration that also carries a deploy-group field", () => {
    expect(ConsumerRegistrationSchema.safeParse({ ...buildOnly, chartPath: "deploy/chart" }).success).toBe(false);
  });

  it("accepts a stage registration (the whole deploy group, no builds[])", () => {
    expect(ConsumerRegistrationSchema.safeParse(stage).success).toBe(true);
  });

  it("rejects a stage registration that also carries builds[]", () => {
    expect(ConsumerRegistrationSchema.safeParse({ ...stage, builds: ["acme-backend"] }).success).toBe(false);
  });

  it("enforces name == basename(repoURL)", () => {
    expect(ConsumerRegistrationSchema.safeParse({ ...buildOnly, name: "other" }).success).toBe(false);
  });
});

describe("consumerArgoAppName", () => {
  it("stamps <name>-<stage> to match the consumers appset template", () => {
    expect(consumerArgoAppName("example-auth", "prod")).toBe("example-auth-prod");
    expect(consumerArgoAppName("example-plane", "dev")).toBe("example-plane-dev");
  });
});

describe("consumerArgocdUrl", () => {
  it("targets the master's own ArgoCD (argo.<fqdn>) for the master self-cluster (ns 'argocd')", () => {
    expect(consumerArgocdUrl("m1.example.com", "argocd", "example-auth-prod")).toBe(
      "https://argo.m1.example.com/applications/example-auth-prod",
    );
  });

  it("targets the per-slave ArgoCD instance (argo-<slave>.<fqdn>) when the namespace is a slave name", () => {
    expect(consumerArgocdUrl("m1.example.com", "s1", "example-post-prod")).toBe(
      "https://argo-s1.m1.example.com/applications/example-post-prod",
    );
  });

  it("returns null when the master FQDN is unknown, so the caller renders no link", () => {
    expect(consumerArgocdUrl(null, "argocd", "example-auth-prod")).toBeNull();
  });
});
