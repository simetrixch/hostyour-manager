import { describe, it, expect, afterEach } from "vitest";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import {
  makeHarness, disposeHarnesses, scriptedHosts, hostsFactory, logger,
  SLAVE_ID, PARAMS, ANSIWISE_PIN, ANSIWISE_DOWNLOAD_URL, ANSIWISE_CATALOG_URL,
  type HostsScript, type Harness,
} from "./deploy-slave.fixture.ts";
import { statedTarget, type DeploySlavePorts } from "./defs/deploy-slave.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";
import {
  placeAnsiwiseStep, parseProbe, placement, probeScript,
  ANSIWISE_BINARY_LINK, CATALOG_CHECKOUT, UNVERSIONED,
} from "./defs/place-ansiwise.ts";

// place-ansiwise is the step every other machine-side step stands on: `ansiwise serve` is a binary
// reading a catalogue, and until this ran a machine has neither. Four things are held down here.
//
// THE PIN DECIDES, never the caller. What is placed is the version platform/versions.yaml states,
// and a machine already carrying a different one is brought onto it.
//
// PLACING TWICE PLACES NOTHING. The scripted machine carries the placement as state that the
// PLACING SCRIPT writes and the PROBE reads, so the second run of the step measures what the first
// one left. Nothing is adjusted between the two runs — an idempotence test whose test moved the
// world in between would be a test of the test.
//
// THE CATALOGUE AND THE MATERIAL ARE TWO REPOSITORIES, at two paths. The platform checkout is what
// the deployment programs ACT on; the catalogue at CATALOG_CHECKOUT is what they are READ from, and
// the first version of this step cloned only the first and then looked for programs inside it — a
// refusal on every real machine that no test could see.
//
// A CHECKOUT IS NOT A CATALOGUE. A tree that carries no ansiwise/programs is refused by name: every
// later step starts a program BY NAME, and a machine with the tree and none of the files fails on
// the first of them with nothing said about why.

const ELEVATION = "elevation-password-SECRET-0007";
const CATALOG_TOKEN = "catalog-read-token-SECRET-0008";
const PORTS_URL = "https://github.com/acme/hostyour-cloud.git";

afterEach(() => disposeHarnesses());

/** The ports the step takes, with one of them left out where a test is about an installation that
 *  did not configure it, or the catalogue credential added where it is about a private catalogue. */
function ports(h: Harness, variant?: "download-url" | "repo-url" | "catalog-url" | "with-token"): DeploySlavePorts & AnsiwisePorts {
  return {
    platformRepo: h.platformRepo,
    ...(variant === "repo-url" ? {} : { platformRepoUrl: PORTS_URL }),
    ...(variant === "download-url" ? {} : { ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL }),
    ...(variant === "catalog-url" ? {} : { ansiwiseCatalogUrl: ANSIWISE_CATALOG_URL }),
    ...(variant === "with-token" ? { ansiwiseCatalogToken: CATALOG_TOKEN } : {}),
  };
}

/** One step run against the scripted slave. `runId` is what makes the uploaded script's path unique,
 *  exactly as a second run of the real step has a second run id. */
function placeCtx(h: Harness, hosts: HostsScript, runId: string, log: string[]): StepCtx {
  const factory = hostsFactory(hosts);
  const session = (): Promise<SshSession> => factory({
    host: "10.1.1.11", port: 22, username: "ubuntu",
    auth: { kind: "key", privateKey: Buffer.from("k") },
  });
  let checkpoint: unknown;
  return {
    runId,
    stepName: "place-ansiwise",
    db: h.db.db,
    creds: h.store,
    params: { serverId: SLAVE_ID },
    secrets: {
      get: (name) => (name === ANSIWISE_ELEVATION_SECRET ? Buffer.from(ELEVATION, "utf8") : undefined),
      wipe: () => undefined,
    },
    signal: new AbortController().signal,
    logger,
    ssh: session,
    openPasswordSession: () => Promise.reject(new Error("not in this test")),
    closePasswordSession: () => undefined,
    attest: () => Promise.resolve(),
    log: (_stream, text) => log.push(text),
    checkpoint: (data) => (checkpoint = data),
    readCheckpoint: <T,>() => checkpoint as T | undefined,
    registerCleanup: () => undefined,
  };
}

const target = statedTarget(SLAVE_ID, PARAMS.domain, "prod");

/** The placing scripts this run of the step put on the machine — none means it placed nothing. */
function placingScripts(hosts: HostsScript): string[] {
  return hosts.files.filter((f) => f.path.includes("dc-place-ansiwise-")).map((f) => f.content);
}

describe("place-ansiwise", () => {
  it("places the pin, the catalogue and the checkout on a machine carrying none of them — and a SECOND run places nothing", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const first: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place1", first));

    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
    expect(hosts.catalogCheckout, "the machine was left with no catalogue — its first program would die by name").toBe(true);
    expect(hosts.programs).toBe(true);
    expect(hosts.platformCheckout).toBe(true);
    expect(hosts.missingCommands).toEqual([]);
    expect(placingScripts(hosts)).toHaveLength(1);
    // Two repositories, two paths, in ONE script: the catalogue the programs are read from and the
    // tree they act on.
    const placed = placingScripts(hosts)[0] ?? "";
    expect(placed).toContain(`clone --branch "master" "${ANSIWISE_CATALOG_URL}" "${CATALOG_CHECKOUT}"`);
    expect(placed).toContain(`clone --branch "${PARAMS.domain}" "${PORTS_URL}" "/srv/hostyour-cloud"`);
    expect(first.some((l) => l.includes(`carries ansiwise ${ANSIWISE_PIN}`))).toBe(true);
    expect(first.some((l) => l.includes(CATALOG_CHECKOUT))).toBe(true);

    // The same step again, over the machine the first run left. Nothing about the world is touched
    // in between: the second run reads what the first one wrote.
    const second: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place2", second));

    expect(placingScripts(hosts), "the second run put a placing script on a machine that already carried everything").toHaveLength(1);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
  });

  it("replaces a binary of another version — the pin decides, not what the machine happens to carry", async () => {
    const hosts = scriptedHosts({ placedBinary: "0.0.9", platformCheckout: true, catalogCheckout: true, programs: true, missingCommands: [] });
    const h = await makeHarness({ hosts });
    const log: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place3", log));

    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
    const script = placingScripts(hosts)[0] ?? "";
    // The version reaches the machine twice and from one source: in the address it is fetched from
    // and in the name it is installed under, which is what makes the placed version readable later.
    expect(script).toContain(`https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/ansiwise-linux-amd64`);
    expect(script).toContain(`/usr/local/bin/ansiwise-${ANSIWISE_PIN}`);
    expect(script).toContain(`ln -sfn "/usr/local/bin/ansiwise-${ANSIWISE_PIN}" "${ANSIWISE_BINARY_LINK}"`);
    // Both checkouts stood already, so nothing cloned either of them a second time.
    expect(script).not.toContain("clone");
    expect(log.some((l) => l.includes("it carries 0.0.9"))).toBe(true);
  });

  it("takes the pin from the platform repo, so a moved pin moves what is placed", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts, versionsYaml: 'cliTools:\n  ansiwise:\n    version: "9.9.9"\n' });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place4", []));
    expect(hosts.placedBinary).toBe("9.9.9");
  });

  it("replaces a binary standing under the plain name, whose version nothing can read", async () => {
    const hosts = scriptedHosts({ placedBinary: UNVERSIONED, platformCheckout: true, catalogCheckout: true, programs: true, missingCommands: [] });
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place5", []));
    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
  });

  it("refuses a catalogue checkout that carries no programs, and names the setting that chose it", async () => {
    // ANSIWISE_CATALOG_URL naming a repository that is not the catalogue — the platform repository
    // is the one an installation reaches for, and `ls ansiwise` in a hostyour-cloud checkout answers
    // nothing (platform/versions.yaml:22-24 names the two trees apart). The step REFUSES rather than
    // reporting a machine ready whose first program would die with a shell error.
    const hosts = scriptedHosts({ programsAfterClone: false });
    const h = await makeHarness({ hosts });
    const run = placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place6", []));
    await expect(run).rejects.toThrow(/carries no ansiwise\/programs/);
    await expect(run).rejects.toThrow(new RegExp(`ANSIWISE_CATALOG_URL names ${ANSIWISE_CATALOG_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("refuses when the download the placement fetched did not produce the pin", async () => {
    // The machine answers the second probe with a version that is not the one asked for — what a
    // fetch of an error page, a redirect to `latest`, or a wrong asset name leaves behind. The step
    // reads its verdict off the machine, so this cannot pass as a success.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const ctx = placeCtx(h, hosts, "run_place7", []);
    const step = placeAnsiwiseStep(target, ports(h));
    const session = await ctx.ssh();
    const exec = session.exec.bind(session);
    session.exec = async (command, o) => {
      const r = await exec(command, o);
      if (command.includes("dc-place-ansiwise-")) hosts.placedBinary = "0.0.1";
      return r;
    };
    await expect(step.run({ ...ctx, ssh: () => Promise.resolve(session) }))
      .rejects.toThrow(new RegExp(`points at 0\\.0\\.1 after the placement, not at the pinned ${ANSIWISE_PIN}`));
  });

  it("refuses an installation that does not say where a version is fetched from, naming the setting", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await expect(placeAnsiwiseStep(target, ports(h, "download-url")).run(placeCtx(h, hosts, "run_place8", [])))
      .rejects.toThrow(/ANSIWISE_DOWNLOAD_URL is not configured/);
    expect(placingScripts(hosts), "it reached the machine before finding out it had no address to fetch from").toHaveLength(0);
  });

  it("refuses an installation that does not name the repository the machine clones, naming the setting", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await expect(placeAnsiwiseStep(target, ports(h, "repo-url")).run(placeCtx(h, hosts, "run_place9", [])))
      .rejects.toThrow(/GITHUB_REPO names that repository/);
  });

  it("refuses an installation that does not name the repository the CATALOGUE comes from, naming the setting", async () => {
    // The platform repository cannot stand in for it: an installation that left this unset has no
    // programs to serve, and the refusal says which setting decides that rather than letting the
    // machine be given a binary with nothing to run.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await expect(placeAnsiwiseStep(target, ports(h, "catalog-url")).run(placeCtx(h, hosts, "run_place11", [])))
      .rejects.toThrow(/ANSIWISE_CATALOG_URL is not configured/);
    expect(placingScripts(hosts), "it reached the machine before finding out it had no catalogue to place").toHaveLength(0);
  });

  it("keeps the elevation password off the machine's disk — it rides standard input, never the script", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place10", []));
    for (const f of hosts.files) expect(f.content).not.toContain(ELEVATION);
    expect(placingScripts(hosts)[0]).toContain("sudo -S -p '' -v");
  });

  it("keeps the CATALOGUE credential off the machine's disk the same way, and hands it to git through the environment", async () => {
    // A private catalogue is the case this installation actually has. The credential may stand in no
    // file the step writes and in no command's arguments — the machine's process listing is readable
    // by anyone on it — so it rides standard input into a variable git reads out of the environment.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h, "with-token")).run(placeCtx(h, hosts, "run_place12", []));
    for (const f of hosts.files) expect(f.content).not.toContain(CATALOG_TOKEN);
    const script = placingScripts(hosts)[0] ?? "";
    expect(script).toContain("IFS= read -r ANSIWISE_CATALOG_TOKEN");
    expect(script).toContain('"$ANSIWISE_CATALOG_TOKEN"');
    expect(hosts.catalogCheckout).toBe(true);
  });
});

describe("the placement scripts", () => {
  it("reads the five facts a placement decides on, and closes with PROBED", () => {
    const state = parseProbe([
      "BINARY 0.4.2", "PLATFORM present", "CATALOG present", "PROGRAMS absent", "MISSING git", "MISSING curl", "PROBED",
    ].join("\n"));
    expect(state).toEqual({ binary: "0.4.2", platform: true, catalog: true, programs: false, missingCommands: ["git", "curl"] });
    expect(parseProbe("BINARY absent\nPLATFORM absent\nCATALOG absent\nPROGRAMS absent\nPROBED").binary).toBeUndefined();
  });

  it("tells the two checkouts apart — the material and the catalogue are separate facts", () => {
    // The shape that produced the first version's refusal on every real machine: a platform checkout
    // standing, and the catalogue absent. Read as one fact, that machine looks placed.
    const state = parseProbe("BINARY 0.4.2\nPLATFORM present\nCATALOG absent\nPROGRAMS absent\nPROBED");
    expect(state.platform).toBe(true);
    expect(state.catalog).toBe(false);
    expect(probeScript()).toContain(`[ -d "${CATALOG_CHECKOUT}/ansiwise/programs" ]`);
  });

  it("refuses a probe that did not finish — a read cut short must never look like a machine carrying nothing", () => {
    // Without the closing line this reads as BINARY absent / CATALOG absent, and the step would
    // install over a working machine on the strength of output that stopped mid-write.
    expect(() => parseProbe("BINARY 0.4.2\nCATALOG present")).toThrow(/probe did not finish/);
    expect(probeScript()).toContain('echo "PROBED"');
  });

  it("composes only the parts the probe asked for", () => {
    const base = {
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
    };
    const all = placement({ ...base, place: { commands: true, binary: true, platform: true, catalog: true } }).script;
    expect(all).toContain("apt-get install -y curl ca-certificates git");
    expect(all).toContain(`clone --branch "s1.example.com" "${PORTS_URL}"`);
    expect(all).toContain(`clone --branch "master" "${ANSIWISE_CATALOG_URL}"`);
    expect(all).toContain('echo "PLACED_BINARY 0.4.2"');

    const none = placement({ ...base, place: { commands: false, binary: false, platform: false, catalog: false } }).script;
    expect(none).not.toContain("apt-get");
    expect(none).not.toContain("curl -fsSL");
    expect(none).not.toContain("clone");
    expect(none).toContain('echo "PLACED"');
  });

  it("puts the credentials on standard input in the order the script reads them, and never in the script", () => {
    // The two halves are composed together for this reason: the script READS its input line by line,
    // so a buffer that carried one credential where the script expects two would hand the elevation
    // password to git and leave sudo waiting.
    const base = {
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
    };
    const withToken = placement({ ...base, catalogToken: CATALOG_TOKEN, place: { commands: false, binary: false, platform: false, catalog: true } });
    expect(withToken.stdin.toString("utf8")).toBe(`${CATALOG_TOKEN}\n${ELEVATION}\n`);
    expect(withToken.script).not.toContain(CATALOG_TOKEN);
    expect(withToken.script).not.toContain(ELEVATION);

    // A public catalogue, and a run that clones nothing: no credential is read, so none is sent.
    const noToken = placement({ ...base, place: { commands: false, binary: false, platform: false, catalog: true } });
    expect(noToken.stdin.toString("utf8")).toBe(`${ELEVATION}\n`);
    expect(noToken.script).not.toContain("read -r ANSIWISE_CATALOG_TOKEN");
    const nothingToClone = placement({ ...base, catalogToken: CATALOG_TOKEN, place: { commands: false, binary: true, platform: false, catalog: false } });
    expect(nothingToClone.stdin.toString("utf8")).toBe(`${ELEVATION}\n`);
    expect(nothingToClone.script).not.toContain("read -r ANSIWISE_CATALOG_TOKEN");
  });

  it("refuses to put a value into a command on the machine that is not one it may put there", () => {
    const base = {
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
      place: { commands: false, binary: true, platform: true, catalog: true },
    };
    expect(() => placement({ ...base, version: '1.0"; rm -rf /' })).toThrow(/is not a value this step may put into a command/);
    expect(() => placement({ ...base, branch: "$(id)" })).toThrow(/is not a value this step may put into a command/);
    expect(() => placement({ ...base, repoUrl: "http://insecure.example.invalid/x.git" })).toThrow(/is not a value this step may put into a command/);
    expect(() => placement({ ...base, catalogUrl: "http://insecure.example.invalid/x.git" })).toThrow(/is not a value this step may put into a command/);
    expect(() => placement({ ...base, user: "root; id" })).toThrow(/is not a value this step may put into a command/);
    // A credential with a line break in it would leave its tail standing where the next credential is
    // read. The refusal may not quote it — it would then be in the run log.
    const broken = "first\nsecond";
    expect(() => placement({ ...base, catalogToken: broken })).toThrow(/catalogue credential carries a line break/);
    try {
      placement({ ...base, elevationPassword: broken });
      expect.unreachable("a password carrying a line break was accepted");
    } catch (err) {
      expect((err as Error).message).toContain("elevation password carries a line break");
      expect((err as Error).message).not.toContain("second");
    }
  });
});
