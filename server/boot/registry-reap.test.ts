import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pino } from "pino";
import { openDb, type DbHandle } from "../db/client.ts";
import { CredentialStore } from "../security/store.ts";
import { FakeGitHubApp } from "../adapters/github-app/testing/fake.ts";
import { recordTestOwners, ORG } from "../domains/units/tenant-apps-repo.fixture.ts";
import { reaperUnitCredential } from "./registry-reap.ts";

// The reaper reads every unit's chart with the identity the server reaches that unit with, from the
// server's own database and store: a unit whose owner is reached by a repository PAT, not the App,
// is read like one the App reaches.
describe("the registry reaper's unit credential", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
  afterEach(() => { db.sqlite.close(); });

  it("reaches a unit through its owner's repository PAT, and one the App reaches through the App's row", async () => {
    const githubApp = new FakeGitHubApp();
    githubApp.org = ORG;
    const credential = reaperUnitCredential({ db: db.db, store: new CredentialStore({ db: db.db, logger: pino({ level: "silent" }) }), githubApp });
    await expect(credential("https://github.com/acme/shop.git")).resolves.toBe("cred_pat_acme");
    await expect(credential(`https://github.com/${ORG}/apps.git`)).resolves.toBe("cred_app");
  });

  it("refuses a unit neither the App nor its owner's PAT reaches", async () => {
    const githubApp = new FakeGitHubApp();
    githubApp.org = ORG;
    const credential = reaperUnitCredential({ db: db.db, store: new CredentialStore({ db: db.db, logger: pino({ level: "silent" }) }), githubApp });
    await expect(credential("https://github.com/stranger/shop.git")).rejects.toThrow(/records no repository PAT/);
  });
});
