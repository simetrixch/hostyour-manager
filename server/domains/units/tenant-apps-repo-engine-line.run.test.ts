// record-apps-repo judges the bundle this pass built against the versions the tenant holds, before the
// registration names it: the plan judged the catalog's engine where no unit stood registered, and a
// repository an earlier pass left standing keeps its own apps.yaml (engine-line.ts). Kept apart from
// tenant-apps-repo.run.test.ts, which stands at the line budget.
import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { recordAppsRepoStep } from "./tenant-apps-repo.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import { BUNDLE, GUID, IMAGE_TAG, ORG, SHA, SUBDOMAIN, TEMPLATE_APPS_YAML, TENANT_URL, UNIT } from "./tenant-apps-repo.fixture.ts";

const ON_03 = "0.3.004-stable-20260928080242-a1b2c3d";

/** A tenant registered with example-engine at ON_03, and its own repository at the release IMAGE_TAG was
 *  built from, written for `line`; `run` records the bundle as this pass built it. */
async function recordBeside(line: string) {
  const registrations = new TenantRegistrations(new FakePlatformRepo());
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: SUBDOMAIN, apps: [{ name: "erp" }], members: testMembers(["erp"]), identityProvider: "auth",
    quota: seedQuota("small"), seedUsers: false, resetNonce: "1", suspended: false, quiesced: false, approvedTags: { erp: { "example-engine": ON_03 } },
  });
  await registrations.commitTenant({ stage: "prod", guid: GUID, registration, runId: "run_0" });
  const repo = new FakeRepoReader({ resolvedSha: SHA, files: {} });
  repo.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "apps.yaml": `${TEMPLATE_APPS_YAML}engine:\n  build: example-engine\n  line: "${line}"\n` } });
  const step = recordAppsRepoStep({ registrations, repo } as unknown as TenantOnboardPorts, { subdomain: SUBDOMAIN, guid: GUID, stage: "prod", org: ORG, bundle: BUNDLE }, { appsImageTag: IMAGE_TAG });
  const run = () => step.run({ runId: "run_1", log: () => undefined, checkpoint: () => undefined, signal: new AbortController().signal } as unknown as StepCtx);
  return { registrations, repo, run };
}

describe("record-apps-repo judges the bundle this pass built against the tenant's versions", () => {
  it("names a bundle written for the line the tenant's engines run on, read at the release it was built from", async () => {
    const r = await recordBeside("0.3");
    await r.run();
    expect((await r.registrations.readTenant("prod", GUID))?.entry).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, appsImageTag: IMAGE_TAG });
    expect(r.repo.clones).toEqual([{ repoURL: TENANT_URL, ref: "0.1.0-stable-20260101000000" }]);
  });

  it("PLANTED DEFECT: names no bundle written for another line, though an earlier pass left its repository standing", async () => {
    const r = await recordBeside("0.4");
    await expect(r.run()).rejects.toThrow(`tenant ${GUID} cannot mount ${UNIT}:${IMAGE_TAG}: the apps bundle is written for example-engine 0.4, and erp would run example-engine ${ON_03}, of another line`);
    expect((await r.registrations.readTenant("prod", GUID))?.entry.appsImageTag).toBe("");
  });
});
