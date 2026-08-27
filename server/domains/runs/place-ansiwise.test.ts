import { describe, it, expect, afterEach } from "vitest";
import {
  makeHarness, disposeHarnesses, scriptedHosts, hostsFactory, ELEVATION_PASSWORD,
  ANSIWISE_PIN, ANSIWISE_DOWNLOAD_URL, type HostsScript,
} from "./deploy-slave.fixture.ts";
import { assetBytes, ScriptedReleases, SCRIPTED_HOME } from "./deploy-slave.placement.fixture.ts";
import { ports, placeCtx, target, transferred, onPath, commands } from "./place-ansiwise.fixture.ts";
import { placeAnsiwiseStep } from "./defs/place-ansiwise.step.ts";
import {
  placeAnsiwise, downloadAddress, assertWord,
  ANSIWISE_EXECUTABLES, ANSIWISE_TOOL, ANSIWISE_REST_TOOL, EXECUTABLE_MODE, BOOTSTRAP_HOME, PATH_HOME,
  NAME_PLACEHOLDER, VERSION_PLACEHOLDER,
  type PlacementMachine,
} from "./defs/place-ansiwise.ts";
import { CATALOG_CHECKOUT } from "./defs/machine-state.ts";

// place-ansiwise is the BOOTSTRAP, and what is held down here is that it is a file transfer and
// nothing else. Everything a machine is given after this is given by a program of its own catalogue;
// this exists only because that apparatus needs an executable before it can measure anything.
//
// NO SHELL REACHES THE MACHINE. The proof is not a reading of the module — it is a reading of every
// command the step actually ran: each is a plain argument list, and a bootstrap that went back to
// composing a script would put a `bash`, a `;`, a `&&` or a `|` into one of them. That is the
// assertion the whole issue turns on, so it is made against what was SENT and never against what the
// code looks like.
//
// BOTH EXECUTABLES, OR NEITHER IS WORTH ANYTHING. `ansiwise-rest` refuses to start when `ansiwise` is
// not standing beside it, so a bootstrap that placed one leaves a machine that answers for programs
// and runs none of them. Two names, one loop, one address with `<name>` in it.
//
// THE PIN DECIDES, never the caller, and never a file name. Both binaries answer `--version`, so what
// says a machine carries the pin is the machine answering the pin — a naming convention this module
// wrote and then read back would only ever repeat its own intention.
//
// PLACING TWICE PLACES NOTHING. The scripted machine carries its executables as the bytes the
// TRANSFER wrote, and `--version` reads them back out, so the second run of the step measures what
// the first one left. Nothing is adjusted in between — an idempotence test whose test moved the world
// would be a test of the test.

afterEach(() => disposeHarnesses());

describe("place-ansiwise", () => {
  it("places BOTH executables at the pin on a machine carrying neither — and a SECOND run places nothing", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const first: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place1", first));

    expect(transferred(hosts).map((f) => f.path), "a machine given one of the two answers for programs and runs none")
      .toEqual([ANSIWISE_TOOL, ANSIWISE_REST_TOOL]);
    // Read back the way the machine reads them: the bytes say which executable and which version
    // they are, and that is the whole of what a placed file is here.
    for (const f of transferred(hosts)) expect(f.content).toBe(assetBytes(f.path, ANSIWISE_PIN).toString("utf8"));
    expect(h.releases.read).toEqual([
      `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_TOOL}-${ANSIWISE_PIN}-linux-x64`,
      `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_REST_TOOL}-${ANSIWISE_PIN}-linux-x64`,
    ]);
    // WHAT IT REPORTS IS WHERE THE MACHINE LOOKS. The home is where the transfer lands; the path is
    // what every later reading asks, `require_cli_tool_versions` among them — so a line naming the
    // home would say a machine carried a version that nothing on it would run.
    expect(first.some((l) => l.includes(`carries ${PATH_HOME}${ANSIWISE_TOOL} and ${PATH_HOME}${ANSIWISE_REST_TOOL} at ${ANSIWISE_PIN}`))).toBe(true);

    // The same step again, over the machine the first run left. Nothing about the world is touched
    // in between: the second run reads what the first one wrote.
    const second: string[] = [];
    const before = hosts.files.length;
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place2", second));
    expect(transferred(hosts, before), "the second run transferred onto a machine that already carried the pin").toHaveLength(0);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
  });

  it("sends the machine argument lists and never a script — no shell syntax reaches it at all", async () => {
    // THE ASSERTION THE ISSUE TURNS ON. The bootstrap composed bash and shipped it; what it may send
    // now is words. A pipeline, a `&&`, a redirection, a `$(…)` or an uploaded `bash <path>` would
    // each show up in exactly one of these lines, and none of them can be written as one plain word.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_noshell", []));

    expect(commands(hosts).length).toBeGreaterThan(0);
    for (const command of commands(hosts)) {
      for (const word of command.split(" ")) expect(() => assertWord(word, "word")).not.toThrow();
      expect(command).not.toMatch(/bash|sh -c|[;&|<>$`(){}*?[\]'"\\]/);
    }
    // And nothing was written to the machine that is not one of the two executables. The composed
    // script used to be a file on the machine's disk for as long as the placement ran.
    expect(transferred(hosts).map((f) => f.path).sort()).toEqual([...ANSIWISE_EXECUTABLES].sort());
  });

  it("writes each executable runnable, in the same act that writes its bytes", async () => {
    // A file transferred without the execute bit is a machine that carries the pin and cannot start
    // it, and a mode set by a second command would be a window in which exactly that is true.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_mode", []));
    expect(hosts.files.every((f) => f.mode === EXECUTABLE_MODE)).toBe(true);
    expect(EXECUTABLE_MODE).toBe(0o755);
  });

  it("takes the pin from the platform repo, so a moved pin moves what is placed", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts, versionsYaml: 'cliTools:\n  ansiwise:\n    version: "9.9.9"\n' });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place4", []));
    for (const f of transferred(hosts)) expect(f.content).toContain("9.9.9");
    for (const url of h.releases.read) expect(url).toContain("/9.9.9/");
  });

  it("replaces an executable of another version — the pin decides, not what the machine happens to carry", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    // A machine somebody already put an older pair on, by hand or by an earlier pin.
    const factory = hostsFactory(hosts);
    const session = await factory({ host: "10.1.1.11", port: 22, username: "ubuntu", auth: { kind: "key", privateKey: Buffer.from("k") } });
    const signal = new AbortController().signal;
    for (const name of ANSIWISE_EXECUTABLES) await session.putFile(name, assetBytes(name, "0.0.9"), EXECUTABLE_MODE, { signal });
    const already = hosts.files.length;

    const log: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place3", log));
    expect(transferred(hosts, already).map((f) => f.path)).toEqual([...ANSIWISE_EXECUTABLES]);
    for (const name of ANSIWISE_EXECUTABLES) {
      expect(hosts.files.filter((f) => f.path === name).at(-1)?.content).toContain(ANSIWISE_PIN);
    }
    expect(log.some((l) => l.includes("it carries 0.0.9"))).toBe(true);
  });

  it("places only the half that drifted, and leaves the one already at the pin alone", async () => {
    // The upgrade nobody plans for: a machine whose deployment tool was moved onto the pin by
    // deploy-cluster's install_pinned_tool row while the serving binary was left where it was —
    // deliberately, because no step of the framework restarts the unit that runs it
    // (simetrixch/ansiwise-plugins#141). Read as one fact, that machine looks placed.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const factory = hostsFactory(hosts);
    const session = await factory({ host: "10.1.1.11", port: 22, username: "ubuntu", auth: { kind: "key", privateKey: Buffer.from("k") } });
    await session.putFile(ANSIWISE_TOOL, assetBytes(ANSIWISE_TOOL, ANSIWISE_PIN), EXECUTABLE_MODE, { signal: new AbortController().signal });
    const already = hosts.files.length; // what the machine carried is not what this run transferred

    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_half", []));
    expect(transferred(hosts, already).map((f) => f.path)).toEqual([ANSIWISE_REST_TOOL]);
    expect(h.releases.read).toEqual([
      `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_REST_TOOL}-${ANSIWISE_PIN}-linux-x64`,
    ]);
  });

  it("reads its verdict off the machine — a release asset that is not the executable is refused", async () => {
    // What the transfer claimed is never the answer, the second reading is. The address here serves
    // something that is not the executable it names — an error page, a redirect notice, a build for
    // another architecture — and only asking the file can see it.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const wrong = `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_TOOL}-${ANSIWISE_PIN}-linux-x64`;
    h.releases.serves.set(wrong, Buffer.from("<html>404 Not Found</html>", "utf8"));
    await expect(placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place7", [])))
      .rejects.toThrow(new RegExp(`${BOOTSTRAP_HOME}${ANSIWISE_TOOL} on s1 answers nothing after the transfer, not the pinned ${ANSIWISE_PIN}`));
  });

  it("refuses an installation that does not say where a release is fetched from, naming the setting", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await expect(placeAnsiwiseStep(target, ports(h, "download-url")).run(placeCtx(h, hosts, "run_place8", [])))
      .rejects.toThrow(/ANSIWISE_DOWNLOAD_URL is not configured/);
    expect(transferred(hosts), "it reached the machine before finding out it had no address to fetch from").toHaveLength(0);
  });

  it("refuses a manager built with no release reader, and says it is a wiring fault", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await expect(placeAnsiwiseStep(target, ports(h, "no-downloads")).run(placeCtx(h, hosts, "run_place_nodl", [])))
      .rejects.toThrow(/no release reader is wired into this manager/);
    expect(transferred(hosts)).toHaveLength(0);
  });

  it("refuses an address that serves nothing, and names the address", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const gone = `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_REST_TOOL}-${ANSIWISE_PIN}-linux-x64`;
    const releases = new ScriptedReleases();
    releases.get = async (url) => {
      releases.read.push(url);
      if (url === gone) throw new Error(`could not read ${url}: it answered HTTP 404`);
      return assetBytes(url.includes(ANSIWISE_REST_TOOL) ? ANSIWISE_REST_TOOL : ANSIWISE_TOOL, ANSIWISE_PIN);
    };
    await expect(placeAnsiwiseStep(target, { ...ports(h), releaseDownloads: releases }).run(placeCtx(h, hosts, "run_place_404", [])))
      .rejects.toThrow(new RegExp(`could not read ${gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

describe("the download address", () => {
  it("fills BOTH slots, so one address reaches both assets of one release", () => {
    const url = `https://example.invalid/r/${VERSION_PLACEHOLDER}/${NAME_PLACEHOLDER}-${VERSION_PLACEHOLDER}-linux-x64`;
    expect(downloadAddress(url, ANSIWISE_TOOL, "1.2.3")).toBe("https://example.invalid/r/1.2.3/ansiwise-1.2.3-linux-x64");
    expect(downloadAddress(url, ANSIWISE_REST_TOOL, "1.2.3")).toBe("https://example.invalid/r/1.2.3/ansiwise-rest-1.2.3-linux-x64");
  });

  it("refuses a slot nothing filled rather than fetching the text as it stands", async () => {
    // An address carrying a placeholder this does not know. Nothing else fills a slot, so a fetch
    // would send `<arch>` to the release host and place whatever came back.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const leftover = `https://downloads.example.invalid/ansiwise/${VERSION_PLACEHOLDER}/${NAME_PLACEHOLDER}-<arch>`;
    await expect(placeAnsiwiseStep(target, { ...ports(h), ansiwiseDownloadUrl: leftover }).run(placeCtx(h, hosts, "run_place_slot", [])))
      .rejects.toThrow(/still carries <arch> once <name> and <version> were filled in/);
    expect(h.releases.read, "it fetched an address with a slot still standing in it").toHaveLength(0);
  });

  it("is refused by the installation's own settings when either slot is missing", async () => {
    const { parseConfig } = await import("../../kernel/config.ts");
    const base = {
      PUBLIC_URL: "https://c.example.invalid", OIDC_ISSUER: "https://i.example.invalid/",
      OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", MANAGER_VERSION: "0.0.0", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => parseConfig({ ...base, ANSIWISE_DOWNLOAD_URL: "https://e.invalid/ansiwise-<version>" }))
      .toThrow(/must carry <name>/);
    expect(() => parseConfig({ ...base, ANSIWISE_DOWNLOAD_URL: "https://e.invalid/<name>-linux" }))
      .toThrow(/must carry <version>/);
    expect(() => parseConfig({ ...base, ANSIWISE_DOWNLOAD_URL: ANSIWISE_DOWNLOAD_URL })).not.toThrow();
  });
});

describe("what may stand in a command on the machine", () => {
  it("refuses a value that is not one plain word rather than quoting it", () => {
    // The guard is what lets the module say it composes no shell: there is no quoter here, so a value
    // carrying shell syntax has to be refused or it would reach the machine as syntax.
    for (const bad of ['1.0"; rm -rf /', "$(id)", "a b", "x|y", "a&&b", "back`tick", "glob*", "new\nline", ""]) {
      expect(() => assertWord(bad, "version"), bad).toThrow(/is not one plain word/);
    }
    for (const good of ["0.1.0-alpha-20260823000709", "~/ansiwise-rest", "/etc/ansiwise/service-token", "--listen", "100.64.0.11:9953"]) {
      expect(() => assertWord(good, "word"), good).not.toThrow();
    }
  });
});

// THE SAME MECHANISM, REACHED BY SOMETHING THAT IS NOT THIS MANAGER. What holds that down is a suite
// with no manager in it: no harness, no database, no StepCtx, no server row and no ports record —
// only a session, two names and an address. A `placeAnsiwise` that reached for any of the rest could
// not compile here.
const FIRST_INSTALL_FQDN = "apps1.digitacloud.app";

/** The machine as a caller holding nothing but a session sees it. This is the whole of what a Dart
 *  client has to supply — everything else the bootstrap says itself. */
async function sessionMachine(hosts: HostsScript, log: string[]): Promise<PlacementMachine> {
  const session = await hostsFactory(hosts)({
    host: "10.1.1.11", port: 22, username: "ubuntu",
    auth: { kind: "key", privateKey: Buffer.from("k") },
  });
  const signal = new AbortController().signal;
  return {
    name: FIRST_INSTALL_FQDN,
    putFile: (path, content, mode) => session.putFile(path, content, mode, { signal }),
    run: async (argv, o) => {
      const out: string[] = [];
      const result = await session.exec(argv.join(" "), {
        signal, timeoutMs: o.timeoutMs, onStdout: (line) => out.push(line),
        ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
      });
      return { code: result.code, stdout: out.join("\n") };
    },
    log: (line) => log.push(line),
  };
}

describe("the bootstrap with no manager behind it", () => {
  it("places both on a machine no inventory carries, and places nothing the second time", async () => {
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, elevationPassword: ELEVATION_PASSWORD };
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };

    const first: string[] = [];
    const verdict = await placeAnsiwise(await sessionMachine(hosts, first), read, request);
    expect(verdict).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(transferred(hosts).map((f) => f.path)).toEqual([ANSIWISE_TOOL, ANSIWISE_REST_TOOL]);

    const second: string[] = [];
    const before = hosts.files.length;
    const again = await placeAnsiwise(await sessionMachine(hosts, second), read, request);
    expect(again).toEqual({ version: ANSIWISE_PIN, placed: false });
    expect(transferred(hosts, before), "the second bootstrap transferred onto a machine that carried the pin").toHaveLength(0);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
    expect(second.some((l) => l.includes(FIRST_INSTALL_FQDN))).toBe(true);
  });

  it("names the file by the account's own home, so nothing has to know where that is", async () => {
    // The transfer states a RELATIVE path — SFTP resolves it from the home of whoever the session
    // authenticated as — and a command names the same file with `~/` in front of it. A bootstrap that
    // wrote an absolute path would be one that had to be told the account's home, which it is not.
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    await placeAnsiwise(
      await sessionMachine(hosts, []),
      { read: (url) => releases.get(url, { signal: new AbortController().signal }) },
      { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, elevationPassword: ELEVATION_PASSWORD },
    );
    for (const f of transferred(hosts)) expect(f.path.startsWith("/")).toBe(false);
    expect(commands(hosts)).toContain(`${BOOTSTRAP_HOME}${ANSIWISE_TOOL} --version`);
    expect(SCRIPTED_HOME.startsWith("/")).toBe(true);
    expect(ELEVATION_PASSWORD).not.toBe(""); // the bootstrap needs no credential at all — see the suite below
  });

  // THE TRANSFER STILL NEEDS NOTHING, and that is the half of this worth keeping: the bytes arrive
  // over SFTP into the account's own home, with no credential anywhere. What the copy ONTO THE PATH
  // needs is a different question with a different answer — /usr/local/bin belongs to root — and the
  // two are held apart here so a credential can never quietly spread from the second to the first.
  it("carries a credential only where the path is written, and never in the transfer", async () => {
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    await placeAnsiwise(
      await sessionMachine(hosts, []),
      { read: (url) => releases.get(url, { signal: new AbortController().signal }) },
      { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, elevationPassword: ELEVATION_PASSWORD },
    );

    for (const act of hosts.log) {
      if (act.command.startsWith("sudo -S install ")) continue;
      expect(act.stdin, `${act.command} carried a credential`).toBeUndefined();
      expect(act.command).not.toContain("sudo");
    }
    // NEVER IN THE ARGUMENT LIST, wherever it does travel: a password there stands in the machine's
    // process listing for anyone on it to read.
    for (const act of hosts.log) expect(act.command).not.toContain(ELEVATION_PASSWORD);
  });

  // THE STATE MEASURED ON apps4, planted exactly: the HOME carries the pin and the PATH carries
  // nothing, because the transfer had already been done once and nothing had ever written the path.
  // Read as one fact that machine looks placed — and every program on it ran the older engine.
  it("places onto the path when the home already carries the pin and the path does not", async () => {
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, elevationPassword: ELEVATION_PASSWORD };

    const machine = await sessionMachine(hosts, []);
    for (const name of ANSIWISE_EXECUTABLES) {
      await machine.putFile(name, assetBytes(name, ANSIWISE_PIN), EXECUTABLE_MODE);
    }
    const already = hosts.files.length;

    const said: string[] = [];
    const verdict = await placeAnsiwise(await sessionMachine(hosts, said), read, request);

    // NOTHING WAS FETCHED — the home was right — and the path was written all the same.
    expect(transferred(hosts, already), "the home carried the pin, so there was nothing to fetch").toHaveLength(0);
    expect(releases.read, "nothing had to be read from the release host").toHaveLength(0);
    expect(onPath(hosts).map((f) => f.path)).toEqual([ANSIWISE_TOOL, ANSIWISE_REST_TOOL]);
    for (const f of onPath(hosts)) expect(f.content).toBe(assetBytes(f.path, ANSIWISE_PIN).toString("utf8"));
    expect(verdict).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(said.some((l) => l.includes(`carries ${PATH_HOME}${ANSIWISE_TOOL}`))).toBe(true);
  });

  // THE INNOCENT NEIGHBOUR: once BOTH answer the pin there is nothing left to do, and the second
  // run must not write the path again. Without it the check above would pass on a placement that
  // simply installs on every run.
  it("leaves a machine alone once BOTH places answer the pin", async () => {
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, elevationPassword: ELEVATION_PASSWORD };

    await placeAnsiwise(await sessionMachine(hosts, []), read, request);
    const settled = hosts.files.length;

    const said: string[] = [];
    const again = await placeAnsiwise(await sessionMachine(hosts, said), read, request);

    expect(again).toEqual({ version: ANSIWISE_PIN, placed: false });
    expect(hosts.files.slice(settled), "a settled machine was written to again").toHaveLength(0);
    expect(said.some((l) => l.includes("nothing to place"))).toBe(true);
  });
});

// THE CATALOGUE ARRIVES WITH THE ENGINE, and the machine below is a machine and not a marker.
//
// `deploy-cluster`'s `require_cli_tool_versions` row asserts the placed engine against the version
// stamped into the CATALOGUE on the machine, and the catalogue is refreshed by a row of a program —
// which is itself read out of the catalogue. So on the first run after a pin move the machine
// carried the new engine and the old programs, and the assertion failed on apps4 on every pin move
// of 2026-08-27. The refresh now stands in the same step as the placement.
//
// TWO MACHINES, AND ONE MUST NOT BE TRADED FOR THE OTHER. One that already lives carries the
// checkout and is brought forward; one that carries none is left exactly as it was, because putting
// this into a program is what breaks the birth of a machine — that move was tried and reverted, and
// the reason was an answer the client's first-master flow does not send. Nothing here asks a program
// for anything.
//
// AND STILL NO SHELL. The refresh is six argument lists like every other act of this step, held
// against the same guard, so the assertion the whole bootstrap turns on keeps covering it.
describe("place-ansiwise: the catalogue the engine is judged by", () => {
  it("brings an installed machine's catalogue forward in the same step that places the engine", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const said: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_cat1", said));

    // READ OFF THE MACHINE: the head moved to what origin carried, which only a reset onto the
    // fetched branch does. A step that fetched and stopped leaves it where it was.
    expect(hosts.catalogueHead, "the catalogue was fetched and the tree never stood on it").toBe("bbb2222");
    expect(said.some((l) => l.includes(`${CATALOG_CHECKOUT} brought forward on main, aaa1111..bbb2222`))).toBe(true);
    // THE BRANCH CAME OFF THE MACHINE. The fetch and the reset name the branch the checkout stood
    // on, so this manager can never move a machine's catalogue to a branch of its own choosing.
    expect(commands(hosts)).toContain(`git -C ${CATALOG_CHECKOUT} fetch origin main`);
    expect(commands(hosts)).toContain(`git -C ${CATALOG_CHECKOUT} reset --hard origin/main`);
    // NOT RAISED, and that is the ownership rule doing the work rather than a convenience: the
    // catalogue belongs to the account this manager reaches the machine as, so git takes the tree as
    // its own. Raised, git would refuse it and everything the fetch wrote would come back root-owned.
    for (const c of commands(hosts).filter((x) => x.includes(CATALOG_CHECKOUT))) expect(c).not.toContain("sudo");
  });

  it("leaves a machine that carries no catalogue exactly as it was, and says so", async () => {
    // The bare machine. Not a failure and not a silent pass: the step says the machine carries none
    // and names where a clone belongs, because only a program's row knows the origin and the
    // credential by name. It asks that machine NOTHING else about the checkout.
    const hosts = scriptedHosts({ catalogueBranch: undefined });
    const h = await makeHarness({ hosts });
    const said: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_cat2", said));

    expect(said.some((l) => l.includes(`carries no catalogue at ${CATALOG_CHECKOUT}`))).toBe(true);
    expect(commands(hosts).filter((c) => c.startsWith(`git -C ${CATALOG_CHECKOUT}`)), "a machine with no catalogue was asked about one anyway").toEqual([]);
    // And the engine was still placed: a machine without a catalogue is one to bootstrap, not one to
    // refuse.
    expect(transferred(hosts).map((f) => f.path)).toEqual([ANSIWISE_TOOL, ANSIWISE_REST_TOOL]);
  });

  it("refuses a machine whose catalogue would not fetch, rather than driving programs out of a stale one", async () => {
    const hosts = scriptedHosts({ catalogueFetchExit: 128 });
    const h = await makeHarness({ hosts });
    const run = placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_cat3", []));
    await expect(run).rejects.toThrow(new RegExp(`could not fetch main into ${CATALOG_CHECKOUT}`));
    expect(hosts.catalogueHead, "a machine whose fetch failed was reset onto something anyway").toBe("aaa1111");
  });

  it("refuses a catalogue standing on no branch, rather than guessing which one to bring it to", async () => {
    // A detached HEAD names no branch, so there is no head to be brought to. The refusal says that
    // rather than falling back to a branch this repository would have had to choose.
    const hosts = scriptedHosts({ catalogueBranch: "" });
    const h = await makeHarness({ hosts });
    const run = placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_cat4", []));
    await expect(run).rejects.toThrow(new RegExp(`${CATALOG_CHECKOUT} on s1 stands on no branch`));
  });

  // THE INNOCENT NEIGHBOUR: a machine already standing on the head of its branch is reported as
  // such and the head does not move. Without it the first case would pass on a refresh that reports
  // a change whatever the machine answered.
  it("says nothing moved on a machine whose catalogue already stands on the head of its branch", async () => {
    const hosts = scriptedHosts({ catalogueHead: "ccc3333", catalogueRemoteHead: "ccc3333" });
    const h = await makeHarness({ hosts });
    const said: string[] = [];
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_cat5", said));

    expect(hosts.catalogueHead).toBe("ccc3333");
    expect(said.some((l) => l.includes("already stood on the head of main at ccc3333"))).toBe(true);
  });
});
