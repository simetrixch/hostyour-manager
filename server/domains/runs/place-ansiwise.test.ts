import { describe, it, expect, afterEach } from "vitest";
import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import {
  makeHarness, disposeHarnesses, scriptedHosts, hostsFactory, logger,
  SLAVE_ID, PARAMS, ANSIWISE_PIN, ANSIWISE_DOWNLOAD_URL,
  type HostsScript, type Harness,
} from "./deploy-slave.fixture.ts";
import { statedTarget, type DeploySlavePorts } from "./defs/deploy-slave.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";
import {
  placeAnsiwiseStep, parseProbe, placeScript, probeScript,
  ANSIWISE_BINARY_LINK, UNVERSIONED,
} from "./defs/place-ansiwise.ts";

// place-ansiwise is the step every other machine-side step stands on: `ansiwise serve` is a binary
// reading a catalogue, and until this ran a machine has neither. Three things are held down here.
//
// THE PIN DECIDES, never the caller. What is placed is the version platform/versions.yaml states,
// and a machine already carrying a different one is brought onto it.
//
// PLACING TWICE PLACES NOTHING. The scripted machine carries the placement as state that the
// PLACING SCRIPT writes and the PROBE reads, so the second run of the step measures what the first
// one left. Nothing is adjusted between the two runs — an idempotence test whose test moved the
// world in between would be a test of the test.
//
// A CHECKOUT IS NOT A CATALOGUE. A tree that carries no ansiwise/programs is refused by name: every
// later step starts a program BY NAME, and a machine with the tree and none of the files fails on
// the first of them with nothing said about why.

const ELEVATION = "elevation-password-SECRET-0007";
const PORTS_URL = "https://github.com/acme/hostyour-cloud.git";

afterEach(() => disposeHarnesses());

/** The ports the step takes, with one of them left out where a test is about an installation that
 *  did not configure it. */
function ports(h: Harness, unset?: "download-url" | "repo-url"): DeploySlavePorts & AnsiwisePorts {
  return {
    platformRepo: h.platformRepo,
    ...(unset === "repo-url" ? {} : { platformRepoUrl: PORTS_URL }),
    ...(unset === "download-url" ? {} : { ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL }),
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
  it("places the pin and the checkout on a machine carrying neither — and a SECOND run places nothing", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const first: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place1", first));

    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
    expect(hosts.platformCheckout).toBe(true);
    expect(hosts.missingCommands).toEqual([]);
    expect(placingScripts(hosts)).toHaveLength(1);
    expect(first.some((l) => l.includes(`carries ansiwise ${ANSIWISE_PIN}`))).toBe(true);

    // The same step again, over the machine the first run left. Nothing about the world is touched
    // in between: the second run reads what the first one wrote.
    const second: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place2", second));

    expect(placingScripts(hosts), "the second run put a placing script on a machine that already carried everything").toHaveLength(1);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
  });

  it("replaces a binary of another version — the pin decides, not what the machine happens to carry", async () => {
    const hosts = scriptedHosts({ placedBinary: "0.0.9", platformCheckout: true, programs: true, missingCommands: [] });
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
    // The checkout stood already, so nothing cloned it a second time.
    expect(script).not.toContain("git clone");
    expect(log.some((l) => l.includes("it carries 0.0.9"))).toBe(true);
  });

  it("takes the pin from the platform repo, so a moved pin moves what is placed", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts, versionsYaml: 'cliTools:\n  ansiwise:\n    version: "9.9.9"\n' });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place4", []));
    expect(hosts.placedBinary).toBe("9.9.9");
  });

  it("replaces a binary standing under the plain name, whose version nothing can read", async () => {
    const hosts = scriptedHosts({ placedBinary: UNVERSIONED, platformCheckout: true, programs: true, missingCommands: [] });
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place5", []));
    expect(hosts.placedBinary).toBe(ANSIWISE_PIN);
  });

  it("refuses a machine that carries no programs, and says where the catalogue comes from", async () => {
    // THIS IS THE REAL CASE, not an edge one: hostyour-cloud has no `ansiwise/` directory at all —
    // platform/versions.yaml:22-24 puts the programs in the `deploy` tree. Placing that checkout is
    // the open half of #14, so what is asserted here is that the step REFUSES rather than reporting
    // a machine ready whose first program would die with a shell error.
    const hosts = scriptedHosts({ programsAfterClone: false });
    const h = await makeHarness({ hosts });
    const run = placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place6", []));
    await expect(run).rejects.toThrow(/carries no ansiwise\/programs/);
    await expect(run).rejects.toThrow(/installation repository/);
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

  it("keeps the elevation password off the machine's disk — it rides standard input, never the script", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place10", []));
    for (const f of hosts.files) expect(f.content).not.toContain(ELEVATION);
    expect(placingScripts(hosts)[0]).toContain("sudo -S -p '' -v");
  });
});

describe("the placement scripts", () => {
  it("reads the four facts a placement decides on, and closes with PROBED", () => {
    const state = parseProbe([
      "BINARY 0.4.2", "CATALOG present", "PROGRAMS absent", "MISSING git", "MISSING curl", "PROBED",
    ].join("\n"));
    expect(state).toEqual({ binary: "0.4.2", catalog: true, programs: false, missingCommands: ["git", "curl"] });
    expect(parseProbe("BINARY absent\nCATALOG absent\nPROGRAMS absent\nPROBED").binary).toBeUndefined();
  });

  it("refuses a probe that did not finish — a read cut short must never look like a machine carrying nothing", () => {
    // Without the closing line this reads as BINARY absent / CATALOG absent, and the step would
    // install over a working machine on the strength of output that stopped mid-write.
    expect(() => parseProbe("BINARY 0.4.2\nCATALOG present")).toThrow(/probe did not finish/);
    expect(probeScript()).toContain('echo "PROBED"');
  });

  it("composes only the parts the probe asked for", () => {
    const base = { version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL, branch: "s1.example.com", user: "ubuntu" };
    const all = placeScript({ ...base, place: { commands: true, binary: true, catalog: true } });
    expect(all).toContain("apt-get install -y curl ca-certificates git");
    expect(all).toContain("git clone --branch \"s1.example.com\"");
    expect(all).toContain('echo "PLACED_BINARY 0.4.2"');

    const none = placeScript({ ...base, place: { commands: false, binary: false, catalog: false } });
    expect(none).not.toContain("apt-get");
    expect(none).not.toContain("curl -fsSL");
    expect(none).not.toContain("git clone");
    expect(none).toContain('echo "PLACED"');
  });

  it("refuses to put a value into a command on the machine that is not one it may put there", () => {
    const base = { version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL, branch: "s1.example.com", user: "ubuntu", place: { commands: false, binary: true, catalog: true } };
    expect(() => placeScript({ ...base, version: '1.0"; rm -rf /' })).toThrow(/is not a value this step may put into a command/);
    expect(() => placeScript({ ...base, branch: "$(id)" })).toThrow(/is not a value this step may put into a command/);
    expect(() => placeScript({ ...base, repoUrl: "http://insecure.example.invalid/x.git" })).toThrow(/is not a value this step may put into a command/);
    expect(() => placeScript({ ...base, user: "root; id" })).toThrow(/is not a value this step may put into a command/);
  });
});
