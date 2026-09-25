import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import {
  TenantRegistrationSchema,
  TenantValidationReportSchema,
  guid,
  appName,
  memberName,
  subdomain,
  GUID_ALPHABET,
} from "./tenant.ts";
import { SEED_SELECTIONS, chosenSelections, appSelectionsToRequest } from "./app-selections.ts";
import { RESERVED_HOST_LABELS } from "#unit/shared/unit-host.ts";
import { ConsumerManifestSchema, tenantAppsTemplate } from "./consumer.ts";

/** The members a tenant of the test product has: three standing services, then one per app carrying
 *  the two sources a selected app renders. Spelled out here rather than imported from the onboarding
 *  fixture, because shared/ is isomorphic and may not reach into server/. */
function testMembers(apps: readonly ({ name: string } | string)[] = []): unknown[] {
  const names = apps.map((a) => (typeof a === "string" ? a : a.name));
  return [
    ...["auth", "jobs", "report"].map((name) => ({ name, sources: [{ chart: `charts/example-${name}` }] })),
    ...names.map((name) => ({ name, sources: [{ chart: "charts/example-engine" }, { chart: "charts/example-ui" }] })),
  ];
}

// A valid tenant registration (registrations/<guid>/<stage>.yaml body); override
// fields per case. guid/stage are the PATH, never the body, so neither appears here.
function registration(over: Record<string, unknown> = {}): unknown {
  return {
    members: testMembers([{ name: "erp" }]),
    identityProvider: "auth",
    cluster: "s1",
    subdomain: "simetrix",
    apps: [{ name: "erp" }],
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    ...over,
  };
}

describe("guid / GUID_ALPHABET — the tenant identity primitive", () => {
  it("is Crockford base32 minus i/l/o/u (32 symbols, none excluded present)", () => {
    expect(GUID_ALPHABET).toHaveLength(32);
    expect(new Set(GUID_ALPHABET).size).toBe(32); // no duplicates
    for (const c of "ilou") expect(GUID_ALPHABET.includes(c)).toBe(false);
  });

  it("accepts the two live guids", () => {
    for (const g of ["zsjs023ctne0", "e2e8ymj86dk8"]) {
      expect(guid.safeParse(g).success).toBe(true);
    }
  });

  it("rejects wrong length and excluded letters", () => {
    expect(guid.safeParse("zsjs023ctne").success).toBe(false); // 11 chars
    expect(guid.safeParse("zsjs023ctne00").success).toBe(false); // 13 chars
    expect(guid.safeParse("zsjs023ctnei").success).toBe(false); // contains excluded 'i'
    expect(guid.safeParse("ZSJS023CTNE0").success).toBe(false); // upper-case
  });
});

describe("appName + memberName", () => {
  it("holds an app name against THIS tenant's members, never a reserved list", () => {
    // There is no reserved set any more. A name collides only if the tenant it is added to actually
    // has a standing member of that name — which is a fact of that tenant, not of the platform.
    const src = [{ chart: "charts/a", valueFiles: [], values: {} }];
    const base = { cluster: "s1", subdomain: "acme", identityProvider: "auth", apps: [{ name: "auth" }], quota: seedQuota("small") };
    // The app is named after a standing member: the resolver emits TWO members called auth, and the
    // duplicate-name check refuses the pair before either can claim <guid>-auth.
    expect(TenantRegistrationSchema.safeParse({ ...base, members: [
      { name: "auth", namespaceLabels: {}, sources: src },
      { name: "jobs", namespaceLabels: {}, sources: src },
      { name: "auth", namespaceLabels: {}, sources: src },
    ] }).success).toBe(false);
    // And a registration that simply left the app's member out is refused too — it would be recorded
    // as owned and never deployed.
    expect(TenantRegistrationSchema.safeParse({ ...base, members: [
      { name: "auth", namespaceLabels: {}, sources: src },
      { name: "jobs", namespaceLabels: {}, sources: src },
    ] }).success).toBe(false);
    // The same app name is fine for a tenant whose STANDING members do not include it.
    expect(TenantRegistrationSchema.safeParse({ ...base, identityProvider: "idp", members: [
      { name: "idp", namespaceLabels: {}, sources: src },
      { name: "jobs", namespaceLabels: {}, sources: src },
      { name: "auth", namespaceLabels: {}, sources: src },
    ] }).success).toBe(true);
  });

  it("accepts a member name in the shared namespace grammar", () => {
    expect(memberName.safeParse("auth").success).toBe(true);
    expect(memberName.safeParse("Auth").success).toBe(false);
  });

  it("accepts a normal app name and rejects malformed ones", () => {
    expect(appName.safeParse("erp").success).toBe(true);
    expect(appName.safeParse("buildproject").success).toBe(true);
    expect(appName.safeParse("x").success).toBe(false); // too short (needs first + last)
    expect(appName.safeParse("-erp").success).toBe(false); // must start with a letter
    expect(appName.safeParse("erp-").success).toBe(false); // must end alphanumeric
    expect(appName.safeParse("ERP").success).toBe(false); // lower-case only
  });
});

describe("subdomain — one DNS label, never a stage word", () => {
  it("accepts a label and refuses a dotted name, naming why", () => {
    expect(subdomain.safeParse("acme").success).toBe(true);
    expect(subdomain.safeParse("acme-2").success).toBe(true);
    const dotted = subdomain.safeParse("acme.dev");
    expect(dotted.success).toBe(false);
    expect(dotted.error?.issues[0]?.message).toMatch(/one DNS label/);
  });

  it("refuses every stage word — a prod tenant named `dev` would take the dev zone itself", () => {
    for (const word of RESERVED_HOST_LABELS) {
      const refused = subdomain.safeParse(word);
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.message).toMatch(/stage word cannot be a subdomain/);
    }
    expect(RESERVED_HOST_LABELS).toEqual(["dev", "test", "prod"]);
  });
});

describe("TenantRegistrationSchema — the registrations/<guid>/<stage>.yaml body", () => {
  it("parses a full valid registration", () => {
    expect(TenantRegistrationSchema.safeParse(registration()).success).toBe(true);
  });

  it("round-trips cleanly through JSON (serialize -> re-parse is stable, incl. nested apps[])", () => {
    const parsed = TenantRegistrationSchema.parse(registration());
    const reparsed = TenantRegistrationSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("applies defaults for apps/seedUsers/resetNonce/suspended/quiesced when omitted", () => {
    const parsed = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "simetrix", members: [{ name: "auth", sources: [{ chart: "charts/a" }] }], identityProvider: "auth", quota: seedQuota("small") });
    expect(parsed.apps).toEqual([]);
    expect(parsed.seedUsers).toBe(false);
    expect(parsed.resetNonce).toBe("1");
    expect(parsed.suspended).toBe(false);
    expect(parsed.quiesced).toBe(false);
  });

  it("fills both seed tiers false when absent, keeps an explicit tier, and folds legacy seed→seedDemo", () => {
    // A bare {name} default-fills BOTH tiers false; an explicit seedReference/seedDemo survives; a
    // LEGACY {name, seed:true} folds the read-only seed alias to seedDemo (seed is stripped from output).
    const apps = [
      { name: "erp" },
      { name: "web", seedReference: true },
      { name: "crm", seedDemo: true },
      { name: "shop", seed: true },
    ];
    const parsed = TenantRegistrationSchema.parse(registration({ apps, members: testMembers(apps) }));
    expect(parsed.apps).toEqual([
      { name: "erp", seedReference: false, seedDemo: false, selections: {} },
      { name: "web", seedReference: true, seedDemo: false, selections: {} },
      { name: "crm", seedReference: false, seedDemo: true, selections: {} },
      { name: "shop", seedReference: false, seedDemo: true, selections: {} },
    ]);
  });

  it("carries every further selection under selections, and refuses the two seed selections there — one selection has one place", () => {
    const apps = [{ name: "erp", seedReference: true, selections: { seedPrices: true, seedFixtures: false } }];
    const parsed = TenantRegistrationSchema.parse(registration({ apps, members: testMembers(apps) }));
    expect(parsed.apps).toEqual([{ name: "erp", seedReference: true, seedDemo: false, selections: { seedPrices: true, seedFixtures: false } }]);
    for (const k of SEED_SELECTIONS) {
      const dup = [{ name: "erp", selections: { [k]: true } }];
      const r = TenantRegistrationSchema.safeParse(registration({ apps: dup, members: testMembers(dup) }));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/never keys of selections/);
    }
  });

  it("chosenSelections names what an entry chose: the two fields where true, every selections key; appSelectionsToRequest is its inverse", () => {
    expect(chosenSelections({})).toEqual([]);
    expect(chosenSelections({ seedReference: true, seedDemo: false, selections: { seedPrices: false } })).toEqual(["seedReference", "seedPrices"]);
    const entry = appSelectionsToRequest("erp", { seedReference: true, seedDemo: false, seedPrices: false });
    expect(entry).toEqual({ name: "erp", seedReference: true, seedDemo: false, selections: { seedPrices: false } });
    expect(chosenSelections(entry)).toEqual(["seedReference", "seedPrices"]);
  });

  it("requires cluster as a DNS-1123 label (the ArgoCD destination name pin)", () => {
    const { cluster, ...noCluster } = registration() as Record<string, unknown>;
    void cluster;
    expect(TenantRegistrationSchema.safeParse(noCluster).success).toBe(false); // required
    expect(TenantRegistrationSchema.safeParse(registration({ cluster: "S1" })).success).toBe(false); // upper-case
    expect(TenantRegistrationSchema.safeParse(registration({ cluster: "s1.example.com" })).success).toBe(false); // a domain is not a name
    expect(TenantRegistrationSchema.safeParse(registration({ cluster: "s1" })).success).toBe(true);
  });

  it("rejects an app named after one of THIS tenant's standing members", () => {
    // The resolver appends one member per app, so an app named after a standing member produces two
    // members of that name and the duplicate check refuses the pair. Nothing here is a reserved list:
    // the same three names are ordinary app names for a tenant whose product does not declare them.
    for (const name of ["auth", "jobs", "report"]) {
      const apps = [{ name }];
      expect(TenantRegistrationSchema.safeParse(registration({ apps, members: testMembers(apps) })).success).toBe(false);
    }
    // Any other name is an app name like any other.
    const apps = [{ name: "base" }];
    expect(TenantRegistrationSchema.safeParse(registration({ apps, members: testMembers(apps) })).success).toBe(true);
  });

  it("rejects duplicate app names", () => {
    expect(TenantRegistrationSchema.safeParse(registration({ apps: [{ name: "erp" }, { name: "erp" }] })).success).toBe(false);
  });

  it("requires resetNonce to be non-empty, defaulting to \"1\"", () => {
    expect(TenantRegistrationSchema.safeParse(registration({ resetNonce: "" })).success).toBe(false);
    expect(TenantRegistrationSchema.parse(registration({ resetNonce: "7" })).resetNonce).toBe("7");
  });

  it("has NO repoURL / repoCredentialId (repo is always catalog)", () => {
    const parsed = TenantRegistrationSchema.parse(registration()) as Record<string, unknown>;
    expect("repoURL" in parsed).toBe(false);
    expect("repoCredentialId" in parsed).toBe(false);
  });

  it("has NO guid / stage / chartsRef — the path (registrations/<guid>/<stage>.yaml) is the identity", () => {
    const parsed = TenantRegistrationSchema.parse(registration()) as Record<string, unknown>;
    expect("guid" in parsed).toBe(false);
    expect("stage" in parsed).toBe(false);
    expect("chartsRef" in parsed).toBe(false);
  });

  describe("the tenant's own apps bundle — appsRepo, appsImage, appsImageTag", () => {
    const BUNDLE = { appsRepo: "https://github.com/acme/acme-apps.git", appsImage: "acme-apps", appsImageTag: "0.1.0-stable-20260101000000-abc1234" };
    it("carries all three, and round-trips them", () => {
      const parsed = TenantRegistrationSchema.parse(registration(BUNDLE));
      expect(parsed).toMatchObject(BUNDLE);
      expect(TenantRegistrationSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });
    it("carries the empty pair for a tenant without one — what the composer writes so the appset reads both bare", () => {
      const parsed = TenantRegistrationSchema.parse(registration({ appsImage: "", appsImageTag: "" }));
      expect(parsed.appsImage).toBe("");
      expect(parsed.appsImageTag).toBe("");
      expect(parsed.appsRepo).toBeUndefined();
    });
    it("refuses an image without its tag, a tag without its image, and a repository alone", () => {
      const why = (over: Record<string, unknown>) => TenantRegistrationSchema.safeParse(registration(over)).error?.issues[0]?.message;
      expect(why({ appsRepo: BUNDLE.appsRepo, appsImage: BUNDLE.appsImage })).toMatch(/appsRepo, appsImage and appsImageTag together/);
      expect(why({ appsImageTag: BUNDLE.appsImageTag })).toMatch(/appsRepo, appsImage and appsImageTag together/);
      expect(why({ appsRepo: BUNDLE.appsRepo, appsImage: "", appsImageTag: "" })).toMatch(/appsRepo, appsImage and appsImageTag together/);
    });
    it("holds the image to the flat build-name grammar and the repository to an https .git URL", () => {
      expect(TenantRegistrationSchema.safeParse(registration({ ...BUNDLE, appsImage: "zot.example/acme-apps" })).success).toBe(false);
      expect(TenantRegistrationSchema.safeParse(registration({ ...BUNDLE, appsRepo: "git@github.com:acme/acme-apps.git" })).success).toBe(false);
    });
  });
});

describe("ConsumerManifest tenant: fan-out block", () => {
  function deployManifest(over: Record<string, unknown> = {}): unknown {
    return {
      apiVersion: "hostyour.cloud/v1",
      kind: "ConsumerManifest", mongodb: "shared" as const,
      name: "catalog",
      owner: "platform",
      envs: ["dev", "test", "prod"],
      builds: [{ name: "hostyour-tenant-operator", containerfile: "operator/Dockerfile" }],
      tenant: {
        members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }, { name: "jobs", chart: "charts/example-jobs" }, { name: "report", chart: "charts/example-report" }],
        perApp: {
          engine: { chart: "charts/example-engine" },
          front: { chart: "charts/example-ui", override: { web: { chart: "charts/example-web" } } },
        },
      },
      ...over,
    };
  }

  it("parses a build-only manifest and KEEPS the tenant: block (not stripped by zod)", () => {
    const parsed = ConsumerManifestSchema.parse(deployManifest());
    expect(parsed.tenant).toBeDefined();
    expect(parsed.tenant?.members.find((m) => m.name === "jobs")?.chart).toBe("charts/example-jobs");
    // Exactly one member declares itself the IdP — the flag that replaced a hardcoded member name.
    expect(parsed.tenant?.members.filter((m) => m.identityProvider === true).map((m) => m.name)).toEqual(["auth"]);
    // the name==web -> example-web override survives parsing (data-drives the front chart swap)
    expect(parsed.tenant?.perApp.front.override?.web?.chart).toBe("charts/example-web");
  });

  it("still parses a plain consumer manifest that has no tenant: block", () => {
    const parsed = ConsumerManifestSchema.parse({
      apiVersion: "hostyour.cloud/v1",
      kind: "ConsumerManifest", mongodb: "shared" as const,
      name: "whoami",
      owner: "team@example",
      envs: ["dev"],
      chart: { path: "deploy/chart" },
    });
    expect(parsed.tenant).toBeUndefined();
  });

  it("C4 — rejects a manifest that declares BOTH a tenant: block and its own chart", () => {
    expect(ConsumerManifestSchema.safeParse(deployManifest({ chart: { path: "deploy/chart" } })).success).toBe(false);
  });

  it("rejects an absolute (non-repo-relative) chart path in the tenant: block", () => {
    const bad = deployManifest() as { tenant: { members: { name: string; chart: string }[] } };
    bad.tenant.members[0]!.chart = "/charts/example-auth";
    expect(ConsumerManifestSchema.safeParse(bad).success).toBe(false);
  });

  describe("the apps template — appsBundle + appsRepo, never a build", () => {
    const APPS_REPO = "https://github.com/acme/acme-apps.git";
    const tenant = (deployManifest() as { tenant: Record<string, unknown> }).tenant;
    const withTemplate = (over: Record<string, unknown>) => deployManifest({ tenant: { ...tenant, ...over } });
    const messages = (m: unknown): string => { const r = ConsumerManifestSchema.safeParse(m); return r.success ? "" : r.error.issues.map((i) => i.message).join("; "); };

    it("parses appsBundle beside appsRepo, and the helper answers both", () => {
      const parsed = ConsumerManifestSchema.parse(withTemplate({ appsBundle: "acme-apps", appsRepo: APPS_REPO }));
      expect(parsed.tenant?.appsBundle).toBe("acme-apps");
      expect(parsed.tenant?.appsRepo).toBe(APPS_REPO);
      expect(tenantAppsTemplate(parsed.tenant!)).toEqual({ name: "acme-apps", repo: APPS_REPO });
      // Absent is a valid manifest: the catalog then falls back to the engine chart's overlays.
      const bare = ConsumerManifestSchema.parse(deployManifest()).tenant!;
      expect(bare.appsBundle).toBeUndefined();
      expect(tenantAppsTemplate(bare)).toBeNull();
    });

    it("refuses appsBundle without appsRepo, and appsRepo without appsBundle", () => {
      expect(messages(withTemplate({ appsBundle: "acme-apps" }))).toMatch(/appsBundle "acme-apps" has no appsRepo/);
      expect(messages(withTemplate({ appsRepo: APPS_REPO }))).toMatch(/appsRepo .* names no template/);
    });

    it("refuses a buildRepos entry that builds the template — the platform never builds it", () => {
      const m = messages(withTemplate({ appsBundle: "acme-apps", appsRepo: APPS_REPO, buildRepos: [{ repo: APPS_REPO, builds: ["acme-apps"] }] }));
      expect(m).toMatch(/buildRepos entry .* builds "acme-apps", the apps template — the platform never builds the template/);
      // A buildRepos entry for another image stands beside the template.
      expect(messages(withTemplate({ appsBundle: "acme-apps", appsRepo: APPS_REPO, buildRepos: [{ repo: "https://github.com/acme/acme-engine.git", builds: ["acme-engine"] }] }))).toBe("");
    });

    it("holds appsRepo to the https .git shape", () => {
      expect(ConsumerManifestSchema.safeParse(withTemplate({ appsBundle: "acme-apps", appsRepo: "git@github.com:acme/acme-apps.git" })).success).toBe(false);
    });
  });
});

describe("TenantValidationReportSchema — the fan-out report envelope", () => {
  it("validates a well-formed tenant report reusing GateResult[]/verdict", () => {
    const report = {
      resolvedSha: "0".repeat(40),
      chartsRef: "0".repeat(40),
      probeGuid: "zsjs023ctne0",
      appsValidated: ["erp"],
      resolvedMembers: ["base", "auth", "jobs", "report", "erp-engine", "erp-front"],
      startedAt: 1,
      finishedAt: 2,
      manifest: null,
      gates: [
        {
          id: "T1",
          title: "manifest + tenant block present",
          severity: "hard",
          status: "pass",
          expected: "deploy/platform.yaml is schema-valid and declares a tenant: fan-out block",
          found: "manifest parsed; tenant block present",
          reason: null,
          detail: "ok",
        },
      ],
      verdict: "pass",
      reportHash: "abc",
    };
    expect(TenantValidationReportSchema.safeParse(report).success).toBe(true);
  });
});
