import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { seedQuota } from "../../../shared/unit-size.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { Registrations } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { MASTER_FQDN, MASTER_MARKING_YAML, SLAVE_FQDN, SLAVE_MARKING_YAML } from "../runs/cluster-maps.fixture.ts";
import type { Stage } from "../../../shared/enums.ts";

const unit = (over: { name?: string; repoURL?: string } = {}) => ({ name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, ...over });
const deploy = (over: { stage?: Stage; cluster?: string; smtpEntry?: { service: string; port: number } } = {}) =>
  ({ stage: "prod" as Stage, chartPath: "deploy/chart", cluster: "s1", host: "acme", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"), ...over });

/** The books with three maps: s1 and s2 are slaves the relay reaches on their tailnet addresses, m1 is
 *  a master whose map carries none. */
function books(): { repo: FakePlatformRepo; reg: Registrations } {
  const repo = new FakePlatformRepo();
  repo.seed(repo.booksBranch, clusterMapPath(SLAVE_FQDN), SLAVE_MARKING_YAML);
  repo.seed(repo.booksBranch, clusterMapPath("s2.example.com"), SLAVE_MARKING_YAML.replace(`domain: ${SLAVE_FQDN}`, "domain: s2.example.com").replace("clusterName: s1", "clusterName: s2").replace("apiHost: 100.64.0.11", "apiHost: 100.64.0.12"));
  repo.seed(repo.booksBranch, clusterMapPath(MASTER_FQDN), MASTER_MARKING_YAML);
  return { repo, reg: new Registrations(repo) };
}

describe("Registrations.listSmtpSenders", () => {
  it("names every unit whose registration at the stage carries an SMTP entry, with the cluster it stands on", async () => {
    const { reg } = books();
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: { service: "acme-mta", port: 2525 } }), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: [], deploy: deploy(), runId: "run_3" });
    expect(await reg.listSmtpSenders("prod")).toEqual([{ unit: "acme", cluster: "s1", entry: { service: "acme-mta", port: 2525 } }]);
    expect(await reg.listSmtpSenders("dev")).toEqual([]);
  });

  it("THROWS on a stage file that does not validate — a skipped file would hide a sender and let a second one in", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/broken/prod.yaml", "name: broken\nrepoURL: not-a-url\n");
    await expect(new Registrations(repo).listSmtpSenders("prod")).rejects.toThrow(/registrations\/broken\/prod\.yaml/);
  });
});

describe("the relay target of a stage follows its mail sender, in the commit that changes the sender's registration", () => {
  const RELAY = "installation/values/postfix-prod.yaml";
  const entry = { service: "acme-mta", port: 2525 };
  const relayhost = (repo: FakePlatformRepo): unknown => (parseYaml(repo.read(repo.booksBranch, RELAY) ?? "null") as { postfix?: { config?: { general?: { RELAYHOST?: unknown } } } } | null)?.postfix?.config?.general?.RELAYHOST;
  const paths = (c: { write?: { path: string }[]; remove?: string[] }): string[] => [...(c.write ?? []).map((w) => w.path), ...(c.remove ?? [])];

  it("an onboard attesting an SMTP entry writes it: RELAYHOST onto the entry at the tailnet address of the unit's cluster", async () => {
    const { repo, reg } = books();
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    expect(parseYaml(repo.read(repo.booksBranch, RELAY)!)).toEqual({
      postfix: { config: { general: { RELAYHOST: "[100.64.0.11]:2525" } } },
      relayTarget: { address: "100.64.0.11", port: 2525 },
    });
    expect(repo.read(repo.booksBranch, RELAY)).toMatch(/^# Written by the Manager from the registration of acme at prod, the one unit whose SMTP entry is\n/);
    expect(repo.commits.at(-1)!.write?.map((w) => w.path)).toEqual(["registrations/acme/build.yaml", "registrations/acme/prod.yaml", RELAY]);
  });

  it("a move of the sender rewrites it with the target cluster's address", async () => {
    const { repo, reg } = books();
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    await reg.setCluster("prod", "acme", "s2", "run_2");
    expect(relayhost(repo)).toBe("[100.64.0.12]:2525");
    expect(paths(repo.commits.at(-1)!)).toEqual(["registrations/acme/prod.yaml", RELAY]);
  });

  it("an offboard of the sender removes it, and so does a re-onboard of the sender without the entry", async () => {
    const offboarded = books();
    await offboarded.reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    await offboarded.reg.removeRegistration("prod", "acme", "run_2");
    expect(offboarded.repo.read(offboarded.repo.booksBranch, RELAY)).toBeNull();
    expect(offboarded.repo.commits.at(-1)!.remove).toContain(RELAY);

    const reonboarded = books();
    await reonboarded.reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    await reonboarded.reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy(), runId: "run_2" });
    expect(reonboarded.repo.read(reonboarded.repo.booksBranch, RELAY)).toBeNull();
    expect(reonboarded.repo.commits.at(-1)!.remove).toEqual([RELAY]);
  });

  it("a unit that is no sender never names the file — onboard, move and offboard leave it as the sender wrote it", async () => {
    const { repo, reg } = books();
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: [], deploy: deploy(), runId: "run_0" });
    expect(repo.read(repo.booksBranch, RELAY)).toBeNull();
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    const written = repo.read(repo.booksBranch, RELAY);
    const before = repo.commits.length;
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: [], deploy: deploy(), runId: "run_2" });
    await reg.setCluster("prod", "other", "s2", "run_3");
    await reg.removeRegistration("prod", "other", "run_4");
    expect(repo.commits.slice(before).flatMap(paths)).not.toContain(RELAY);
    expect(repo.read(repo.booksBranch, RELAY)).toBe(written);
  });

  it("refuses to move the sender onto a cluster whose map carries no apiHost, and commits nothing", async () => {
    const { repo, reg } = books();
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ smtpEntry: entry }), runId: "run_1" });
    const before = repo.commits.length;
    await expect(reg.setCluster("prod", "acme", "m1", "run_2")).rejects.toThrow(/clusters\/active\/m1\.example\.com\.yaml carries no global\.apiHost.*deploy-slave for a slave and by tailnet-record-address for a master/);
    expect(repo.commits).toHaveLength(before);
  });
});
