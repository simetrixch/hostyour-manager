import { describe, it, expect } from "vitest";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { admitFirstMasterUngated, readUngatedOnboard, type FirstMasterAdmission } from "./first-master.ts";
import { CONSUMER_MANIFEST_PATH } from "../../../shared/consumer.ts";

const SHA = "b".repeat(40);
const SIGNAL = new AbortController().signal;

/** The state in which the exemption is meant to hold, and the ONLY one: the platform's own unit,
 *  build-only, on an installation that has never onboarded anything, with a master to be about. */
const ADMITTED: FirstMasterAdmission = {
  platformUnitName: "hostyour",
  consumerName: "hostyour",
  buildOnly: true,
  registeredUnits: [],
  masterDomain: "m1.example.com",
};

describe("admitFirstMasterUngated", () => {
  it("admits the platform's own build-only unit at the first installation, and SAYS what admitted it", () => {
    const v = admitFirstMasterUngated(ADMITTED);
    expect(v.admitted).toBe(true);
    if (!v.admitted) return;
    // Every condition, in words, in the record. A boolean would leave whoever reads the run
    // afterwards with nothing to check the branch against.
    expect(v.admittedBy).toHaveLength(4);
    expect(v.admittedBy.join(" ")).toContain("hostyour");
    expect(v.admittedBy.join(" ")).toContain("build-only");
    expect(v.admittedBy.join(" ")).toContain("first installation");
    expect(v.admittedBy.join(" ")).toContain("m1.example.com");
  });

  // ONE CONDITION REMOVED AT A TIME. Each row is a way somebody could try to reach the ungated
  // branch, and each must be refused with a reason naming what stopped it.
  const attempts: [string, Partial<FirstMasterAdmission>, RegExp][] = [
    ["a Manager that names no platform unit at all", { platformUnitName: undefined }, /names no platform unit/],
    ["a customer's unit wearing every other condition", { consumerName: "acme" }, /is not this platform's own unit/],
    ["the platform's own unit onboarded to a target cluster", { buildOnly: false }, /only the build-only form/],
    ["an installation that has already onboarded something", { registeredUnits: ["acme"] }, /not the first installation/],
    ["a platform's own unit re-onboarded after its first install", { registeredUnits: ["hostyour"] }, /not the first installation/],
    ["no cluster in the master role", { masterDomain: undefined }, /no cluster in the master role/],
  ];
  for (const [what, override, says] of attempts) {
    it(`REFUSES ${what}`, () => {
      const v = admitFirstMasterUngated({ ...ADMITTED, ...override });
      expect(v.admitted, what).toBe(false);
      if (v.admitted) return;
      expect(v.refusedBecause).toMatch(says);
    });
  }

  it("REFUSES a customer unit even when the deployment names no platform unit and the name is empty-ish", () => {
    // The absent-name state must not collapse into "everything matches": an unset PLATFORM_UNIT_NAME
    // closes the branch for every name, including one that is itself absent-looking.
    for (const consumerName of ["", "acme", "hostyour"]) {
      const v = admitFirstMasterUngated({ ...ADMITTED, platformUnitName: undefined, consumerName });
      expect(v.admitted, consumerName).toBe(false);
    }
  });
});

describe("readUngatedOnboard", () => {
  const manifest = (extra: string): string =>
    `apiVersion: hostyour.cloud/v1\nkind: ConsumerManifest\nname: hostyour\nowner: platform\nenvs: [dev]\n${extra}`;
  const BUILDS = "builds:\n  - name: hostyour-manager\n    containerfile: Containerfile\n";
  const req = { repoURL: "https://github.com/x/hostyour.git", ref: "HEAD", consumerName: "hostyour" };
  const about = { cluster: "m1.example.com", admittedBy: ["because the test says so"] };
  const deps = (files: Record<string, string>): { repo: FakeRepoReader; log: () => void; signal: AbortSignal } => ({
    repo: new FakeRepoReader({ resolvedSha: SHA, files }),
    log: () => undefined,
    signal: SIGNAL,
  });

  it("reads the build names straight from the manifest, at the resolved sha, and stamps what admitted it", async () => {
    const out = await readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: manifest(BUILDS) }), req, about);
    expect(out.builds).toEqual(["hostyour-manager"]);
    expect(out.resolvedSha).toBe(SHA);
    expect(out.unit).toBe("hostyour");
    expect(out.cluster).toBe("m1.example.com");
    expect(out.admittedBy).toEqual(["because the test says so"]);
    // It is NOT a report and carries none of a report's attestations — there was no sandbox to make
    // them, and a record that carried them would be attesting to a fence nothing observed.
    expect(out).not.toHaveProperty("sandbox");
    expect(out).not.toHaveProperty("reportHash");
    expect(out).not.toHaveProperty("verdict");
  });

  it("REFUSES a manifest that declares a chart — a deployable unit is not what the exemption is for", async () => {
    const charted = manifest(`chart:\n  path: deploy/chart\n${BUILDS}`);
    await expect(readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: charted }), req, about)).rejects.toThrow(/declares a chart/);
  });

  it("REFUSES a manifest naming another unit — the name is the identity and cannot differ", async () => {
    const other = manifest(BUILDS).replace("name: hostyour", "name: acme");
    await expect(readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: other }), req, about)).rejects.toThrow(/declares name "acme"/);
  });

  it("REFUSES a missing manifest, an unparseable one, and one the schema rejects", async () => {
    await expect(readUngatedOnboard(deps({}), req, about)).rejects.toThrow(new RegExp(`carries no ${CONSUMER_MANIFEST_PATH}`));
    await expect(readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: "a: [1,\n" }), req, about)).rejects.toThrow(/not valid YAML/);
    await expect(readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: "apiVersion: nope\n" }), req, about)).rejects.toThrow(/not a valid consumer manifest/);
  });

  it("REFUSES a manifest with no builds — there would be nothing to attest and nothing to build", async () => {
    // Reached through the tenant fan-out shape, which satisfies the manifest's own deploy rule
    // without declaring either a chart or a build.
    // JSON is valid YAML, which keeps a nested fixture out of the business of counting spaces.
    const fanout = JSON.stringify({
      apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", name: "hostyour", owner: "platform", envs: ["dev"],
      tenant: {
        members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }],
        perApp: { engine: { chart: "charts/example-engine" }, front: { chart: "charts/example-ui" } },
      },
    });
    await expect(readUngatedOnboard(deps({ [CONSUMER_MANIFEST_PATH]: fanout }), req, about)).rejects.toThrow(/declares no builds/);
  });
});
