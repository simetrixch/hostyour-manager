// The boot migration of the registrations: a file written before a field gained its default is
// rewritten with it once, a file already in the schema's form yields no commit, a key the schema
// does not know is dropped, and a file the schema refuses is named and left as it stands.
import { describe, it, expect } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { Logger } from "../../kernel/logger.ts";
import { Registrations } from "./registrations.ts";
import { bootMarker, parseRegistration, serializePointer } from "./registration-laws.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { migrateRegistrations } from "./registrations-migration.ts";
import { checkRegistrationsMigrated } from "../../boot/selfchecks.ts";
import { testMembers } from "./tenant-members.fixture.ts";

const MARKER = bootMarker("0.8.203");
const GUID = "zsjs023ctne0";
const TENANT_PATH = `registrations/${GUID}/prod.yaml`;

/** A tenant registration in the WRITER'S form, minus the keys a test takes out to model a file
 *  written before those keys existed. */
function tenantFile(over: Partial<Record<keyof TenantRegistration, unknown>> = {}, drop: (keyof TenantRegistration)[] = []): string {
  return flat({ ...tenantParsed(), appsImage: "", appsImageTag: "", ...over }, drop);
}

/** The parsed shape of tenantFile() without the bundle pair, for a commit through the registry. */
function tenantParsed(): Record<string, unknown> {
  return {
    cluster: "s1", subdomain: "simetrix",
    apps: [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }],
    members: testMembers(["erp"]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [],
    quota: seedQuota("small"), seedUsers: false, resetNonce: "1", suspended: false, quiesced: false,
  };
}

const REPO_URL = "https://github.com/x/acme.git";
const BUILD_PATH = "registrations/acme/build.yaml";
const STAGE_PATH = "registrations/acme/prod.yaml";

/** A consumer build registration and a stage registration, in the writer's form. */
function consumerBuildFile(over: Record<string, unknown> = {}, drop: string[] = []): string {
  return flat({ name: "acme", repoURL: REPO_URL, suspended: false, quiesced: false, removing: false, builds: ["acme"], ...over }, drop);
}
function consumerStageFile(over: Record<string, unknown> = {}, drop: string[] = []): string {
  return flat({ name: "acme", repoURL: REPO_URL, suspended: false, quiesced: false, removing: false, chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"), host: "acme", ...over }, drop);
}
function flat(entry: Record<string, unknown>, drop: string[]): string {
  for (const k of drop) delete entry[k];
  return Object.entries(entry).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
}

function logger(lines: { level: string; args: unknown[] }[]): Logger {
  const at = (level: string) => (...args: unknown[]) => { lines.push({ level, args }); };
  return { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Logger;
}

describe("TenantRegistrations.migrateToSchema", () => {
  it("rewrites a registration lacking appsImage and appsImageTag with the empty pair, once, in one commit naming the file and both fields", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, ["appsImage", "appsImageTag"]));

    const first = await reg.migrateToSchema(MARKER);
    expect(first.read).toBe(1);
    expect(first.rewritten).toEqual([{ path: TENANT_PATH, fields: ["+appsImage", "+appsImageTag"] }]);
    expect(first.refused).toEqual([]);
    expect(first.commit).toBe("commit_1");
    expect(repo.commits).toHaveLength(1);
    const c = repo.commits[0]!;
    expect(c.branch).toBe(repo.booksBranch);
    expect(c.message).toBe(`migrate-registrations: ${TENANT_PATH} +appsImage +appsImageTag [boot 0.8.203]`);
    expect(c.write?.map((w) => w.path)).toEqual([TENANT_PATH]);
    // What stands on the branch afterwards is the writer's own form: both keys, the empty string.
    const after = repo.read(repo.booksBranch, TENANT_PATH)!;
    expect(after).toContain('appsImage: ""');
    expect(after).toContain('appsImageTag: ""');
    expect(after).toBe(tenantFile());

    // Once: the second boot finds the schema's form and commits nothing.
    const second = await reg.migrateToSchema(MARKER);
    expect(second.commit).toBeNull();
    expect(second.rewritten).toEqual([]);
    expect(repo.commits).toHaveLength(1);
  });

  it("rewrites a registration written before the own domain existed with none: the tenant stays at its zone", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, ["ownDomain"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: TENANT_PATH, fields: ["+ownDomain"] }]);
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toBe(tenantFile());
  });

  it("rewrites a registration written before the redirect hosts existed with none", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, ["ownDomainRedirects"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: TENANT_PATH, fields: ["+ownDomainRedirects"] }]);
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toBe(tenantFile());
  });

  it("rewrites a registration written before the routing existed with host, the addressing it was made under", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, ["routing"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: TENANT_PATH, fields: ["+routing"] }]);
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toBe(tenantFile());
  });

  it("commits nothing for a file the registry itself wrote — the serialization is byte-identical", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: TenantRegistrationSchema.parse(tenantParsed()), runId: "run_1" });
    const before = repo.read(repo.booksBranch, TENANT_PATH)!;
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome).toEqual({ read: 1, rewritten: [], refused: [], commit: null });
    expect(repo.commits).toHaveLength(1); // the create-tenant commit alone
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toBe(before);
    // Counter-probe: the same file with one key taken out is NOT byte-identical and IS rewritten.
    repo.seed(repo.booksBranch, TENANT_PATH, before.replace('quiesced: false\n', ""));
    expect((await reg.migrateToSchema(MARKER)).rewritten).toEqual([{ path: TENANT_PATH, fields: ["+quiesced"] }]);
  });

  it("drops a key the schema does not know — z.object() strips unknown keys rather than refusing them", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, []).replace(/\n$/, '\nchartsRef: "abc"\n'));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: TENANT_PATH, fields: ["-chartsRef"] }]);
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toBe(tenantFile());
    expect(repo.commits[0]!.message).toBe(`migrate-registrations: ${TENANT_PATH} -chartsRef [boot 0.8.203]`);
  });

  it("folds a legacy spelling a field's transform folds: apps[].seed becomes seedDemo", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({ apps: [{ name: "erp", seed: true }] }));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: TENANT_PATH, fields: ["~apps"] }]);
    expect(repo.read(repo.booksBranch, TENANT_PATH)).toContain('apps: [{"name":"erp","seedReference":false,"seedDemo":true,"selections":{}}]');
  });

  it("names a file the schema refuses, with its reason, and leaves it as it stands", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    const refusedPath = `registrations/e2e8ymj86dk8/prod.yaml`;
    const refusedBody = tenantFile({ identityProvider: "nobody" }); // not one of the members
    repo.seed(repo.booksBranch, refusedPath, refusedBody);
    repo.seed(repo.booksBranch, TENANT_PATH, tenantFile({}, ["appsImage", "appsImageTag"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.read).toBe(2);
    expect(outcome.refused).toEqual([{ path: refusedPath, reason: expect.stringContaining('identityProvider "nobody" is not one of this tenant\'s members') }]);
    expect(outcome.refused[0]!.reason).toMatch(/^failed its schema: /);
    // Untouched: the same bytes, and not among the commit's writes.
    expect(repo.read(repo.booksBranch, refusedPath)).toBe(refusedBody);
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]!.write?.map((w) => w.path)).toEqual([TENANT_PATH]);
    expect(repo.commits[0]!.message).not.toContain("e2e8ymj86dk8");
  });

  it("names a file that is not YAML, and commits nothing when it is the only file", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    repo.seed(repo.booksBranch, TENANT_PATH, "cluster: [unterminated\n");
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.refused).toEqual([{ path: TENANT_PATH, reason: expect.stringContaining("registration is not valid YAML") }]);
    expect(outcome.commit).toBeNull();
    expect(repo.commits).toEqual([]);
  });

  it("refuses to write a file outside registrations/<guid>/<stage>.yaml, by the registry's own guard", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    const strayPath = "registrations/not-a-guid/prod.yaml";
    repo.seed(repo.booksBranch, strayPath, tenantFile({}, ["appsImage"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.refused).toEqual([{ path: strayPath, reason: expect.stringContaining("path guard") }]);
    expect(repo.commits).toEqual([]);
  });
});

describe("Registrations.migrateToSchema (the consumer registrations: stage files and build.yaml)", () => {
  it("rewrites a stage file and a build.yaml lacking a defaulted key, both in ONE commit naming each file and its field", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    repo.seed(repo.booksBranch, BUILD_PATH, consumerBuildFile({}, ["removing"]));
    repo.seed(repo.booksBranch, STAGE_PATH, consumerStageFile({}, ["quiesced"]));
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.read).toBe(2);
    expect(outcome.rewritten).toEqual([
      { path: BUILD_PATH, fields: ["+removing"] },
      { path: STAGE_PATH, fields: ["+quiesced"] },
    ]);
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]!.message).toBe(`migrate-registrations: ${BUILD_PATH} +removing; ${STAGE_PATH} +quiesced [boot 0.8.203]`);
    expect(repo.read(repo.booksBranch, BUILD_PATH)).toBe(consumerBuildFile());
    expect(repo.read(repo.booksBranch, STAGE_PATH)).toBe(consumerStageFile());
    expect((await reg.migrateToSchema(MARKER)).commit).toBeNull();
    expect(repo.commits).toHaveLength(1);
  });

  it("commits nothing for files the registry itself wrote", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: REPO_URL, suspended: false, quiesced: false }, builds: ["acme"],
      deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", host: "acme", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: "run_1",
    });
    const build = repo.read(repo.booksBranch, BUILD_PATH);
    const stage = repo.read(repo.booksBranch, STAGE_PATH);
    expect(await reg.migrateToSchema(MARKER)).toEqual({ read: 2, rewritten: [], refused: [], commit: null });
    expect(repo.commits).toHaveLength(1);
    expect(repo.read(repo.booksBranch, BUILD_PATH)).toBe(build);
    expect(repo.read(repo.booksBranch, STAGE_PATH)).toBe(stage);
    // The same bytes serializePointer writes for the parsed entry — what the compare rests on.
    expect(serializePointer(ConsumerRegistrationSchema, ConsumerRegistrationSchema.parse(parseRegistration(build!)))).toBe(build);
  });

  it("drops an unknown key from a build.yaml and names a stage file the schema refuses", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    repo.seed(repo.booksBranch, BUILD_PATH, consumerBuildFile({ imageTag: "1.2.3" }));
    const refusedBody = consumerStageFile({}, ["services"]); // the deploy group stands or falls together
    repo.seed(repo.booksBranch, STAGE_PATH, refusedBody);
    const outcome = await reg.migrateToSchema(MARKER);
    expect(outcome.rewritten).toEqual([{ path: BUILD_PATH, fields: ["-imageTag"] }]);
    expect(outcome.refused).toEqual([{ path: STAGE_PATH, reason: expect.stringContaining('"services" is required in a stage registration') }]);
    expect(repo.read(repo.booksBranch, BUILD_PATH)).toBe(consumerBuildFile());
    expect(repo.read(repo.booksBranch, STAGE_PATH)).toBe(refusedBody);
    expect(repo.commits[0]!.write?.map((w) => w.path)).toEqual([BUILD_PATH]);
  });

  it("skips a unit directory without files for a stage rather than counting it", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    repo.seed(repo.booksBranch, BUILD_PATH, consumerBuildFile());
    expect(await reg.migrateToSchema(MARKER)).toEqual({ read: 1, rewritten: [], refused: [], commit: null });
  });
});

describe("migrateRegistrations (the boot act over both books)", () => {
  it("runs both registries with the boot marker and answers each outcome", async () => {
    const platform = new FakePlatformRepo({ booksBranch: "m1.example.com" });
    const catalog = new FakePlatformRepo({ booksBranch: "m1.example.com" });
    platform.seed(platform.booksBranch, BUILD_PATH, consumerBuildFile({}, ["removing"]));
    catalog.seed(catalog.booksBranch, TENANT_PATH, tenantFile({}, ["appsImage", "appsImageTag"]));
    const lines: { level: string; args: unknown[] }[] = [];
    const outcomes = await migrateRegistrations({ registrations: new Registrations(platform), tenantRegistrations: new TenantRegistrations(catalog), version: "0.8.203", logger: logger(lines) });
    expect(outcomes).toEqual([
      { books: "platform", branch: "m1.example.com", read: 1, rewritten: [{ path: BUILD_PATH, fields: ["+removing"] }], refused: [], commit: "commit_1" },
      { books: "catalog", branch: "m1.example.com", read: 1, rewritten: [{ path: TENANT_PATH, fields: ["+appsImage", "+appsImageTag"] }], refused: [], commit: "commit_1" },
    ]);
    expect(platform.commits[0]!.message).toMatch(/ \[boot 0\.8\.203\]$/);
    expect(catalog.commits[0]!.message).toMatch(/ \[boot 0\.8\.203\]$/);
    expect(lines.filter((l) => l.level === "info").map((l) => l.args[1])).toEqual(["registrations migrated to the schema", "registrations migrated to the schema"]);
  });

  it("does nothing and says so where no books are configured", async () => {
    const lines: { level: string; args: unknown[] }[] = [];
    expect(await migrateRegistrations({ version: "0.8.203", logger: logger(lines) })).toEqual([]);
    expect(lines.map((l) => [l.level, (l.args[0] as { books: string }).books])).toEqual([["info", "platform"], ["info", "catalog"]]);
    expect(lines.every((l) => String(l.args[1]).includes("no registration to migrate"))).toBe(true);
  });

  it("logs a books branch that cannot be read as that books' failure, and still resolves", async () => {
    const absent: PlatformRepo = {
      booksBranch: "m1.example.com",
      withBranch: async () => { throw new Error('this installation\'s books branch "m1.example.com" does not exist on https://github.com/x/platform.git'); },
    };
    const catalog = new FakePlatformRepo();
    catalog.seed(catalog.booksBranch, TENANT_PATH, tenantFile());
    const lines: { level: string; args: unknown[] }[] = [];
    const outcomes = await migrateRegistrations({ registrations: new Registrations(absent), tenantRegistrations: new TenantRegistrations(catalog), version: "0.8.203", logger: logger(lines) });
    expect(outcomes[0]).toEqual({ books: "platform", branch: "m1.example.com", failed: expect.stringContaining("does not exist") });
    expect(outcomes[1]).toEqual({ books: "catalog", branch: catalog.booksBranch, read: 1, rewritten: [], refused: [], commit: null });
    expect(lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(catalog.commits).toEqual([]);
  });

  it("warns per refused file with its path and reason", async () => {
    const catalog = new FakePlatformRepo();
    catalog.seed(catalog.booksBranch, TENANT_PATH, tenantFile({ identityProvider: "nobody" }));
    const lines: { level: string; args: unknown[] }[] = [];
    await migrateRegistrations({ tenantRegistrations: new TenantRegistrations(catalog), version: "0.8.203", logger: logger(lines) });
    const warned = lines.filter((l) => l.level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.args[0]).toEqual({ books: "catalog", branch: catalog.booksBranch, path: TENANT_PATH, reason: expect.stringContaining("failed its schema") });
  });
});

describe("checkRegistrationsMigrated (the registrations.schema self-check row)", () => {
  it("skips where no books were migrated", () => {
    expect(checkRegistrationsMigrated([])).toEqual({ name: "registrations.schema", kind: "skipped", ok: false, detail: expect.stringContaining("no books are configured") });
  });

  it("is green with how much each books covered", () => {
    const row = checkRegistrationsMigrated([
      { books: "platform", branch: "m1.example.com", read: 3, rewritten: [{ path: BUILD_PATH, fields: ["+removing"] }], refused: [], commit: "abc" },
      { books: "catalog", branch: "m1.example.com", read: 1, rewritten: [], refused: [], commit: null },
    ]);
    expect(row).toEqual({ name: "registrations.schema", kind: "degrading", ok: true, detail: "platform m1.example.com: 3 read, 1 rewritten (abc), 0 refused; catalog m1.example.com: 1 read, 0 rewritten, 0 refused" });
  });

  it("is red naming every refused file with its reason, and a books that could not be read", () => {
    const row = checkRegistrationsMigrated([
      { books: "platform", branch: "m1.example.com", failed: "the branch does not exist" },
      { books: "catalog", branch: "m1.example.com", read: 2, rewritten: [], refused: [{ path: TENANT_PATH, reason: "failed its schema: identityProvider nobody" }], commit: null },
    ]);
    expect(row.kind).toBe("degrading");
    expect(row.ok).toBe(false);
    expect(row.detail).toBe(`the platform books m1.example.com could not be read: the branch does not exist; catalog books m1.example.com: ${TENANT_PATH} failed its schema: identityProvider nobody — platform m1.example.com: not read; catalog m1.example.com: 2 read, 0 rewritten, 1 refused`);
  });
});
