import { describe, it, expect, afterEach } from "vitest";
import {
  makeHarness, disposeHarnesses, scriptedHosts, ELEVATION_PASSWORD,
  ANSIWISE_PIN, ANSIWISE_DOWNLOAD_URL, ansiwiseDigestMap, ansiwiseDigests, type HostsScript,
} from "./deploy-slave.fixture.ts";
import { assetBytes, ScriptedReleases, ON_PATH } from "./deploy-slave.placement.fixture.ts";
import { ports, placeCtx, target, transferred, onPath, sessionMachine, FIRST_INSTALL_FQDN } from "./place-ansiwise.fixture.ts";
import { placeAnsiwiseStep } from "./defs/place-ansiwise.step.ts";
import {
  placeAnsiwise, ANSIWISE_EXECUTABLES, ANSIWISE_TOOL, ANSIWISE_REST_TOOL, EXECUTABLE_MODE, BOOTSTRAP_HOME, PATH_HOME,
  type PlacementMachine,
} from "./defs/place-ansiwise.ts";

// THE ENGINE IS HELD AGAINST ITS DIGESTS, and this suite is what holds that down: the bytes a
// placement fetches are held against clusters/platform/ansiwise.sha256 before anything of them is
// written, only executables placed in this run reach the path, and what root installed is read
// back off the path and held again. Each test plants the state an attacker or a stale file could
// make, and each goes red without the guard it names. A file of its own beside place-ansiwise.test.ts,
// which holds the placement's other halves, so neither outgrows what one reader takes in.

afterEach(() => disposeHarnesses());

const HOST = "10.1.1.11";
const genuine = (name: string): string => assetBytes(name, ANSIWISE_PIN).toString("utf8");
const swappedCopy = (name: string): string => `#!ansiwise\n${name} ${ANSIWISE_PIN}\n# swapped before the install\n`;
const lastOnPath = (hosts: HostsScript, name: string): string | undefined =>
  onPath(hosts).filter((f) => f.path === name).at(-1)?.content;
const installOf = (name: string): string => `sudo -S install -m 755 ${BOOTSTRAP_HOME}${name} `;

/** What a placement is handed: the release reader and the request, as the step builds them. */
function placement() {
  const releases = new ScriptedReleases();
  return {
    releases,
    read: { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) },
    request: { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, digests: ansiwiseDigestMap(ANSIWISE_PIN), elevationPassword: ELEVATION_PASSWORD },
  };
}

/** The machine of a session, each command passing through `wrap` first: the state a process running
 *  as the operating account can make, or a session that ends, is planted there. */
async function machineWith(
  hosts: HostsScript,
  wrap: (line: string, run: () => ReturnType<PlacementMachine["run"]>) => ReturnType<PlacementMachine["run"]>,
  said: string[] = [],
): Promise<PlacementMachine> {
  const honest = await sessionMachine(hosts, said);
  return { ...honest, run: (argv, o) => wrap(argv.join(" "), () => honest.run(argv, o)) };
}

/** Swaps the home copy of each executable named, at the moment root installs it. */
const swapAtInstall = (hosts: HostsScript, names: readonly string[]) => (line: string): void => {
  for (const name of names) {
    if (line.startsWith(installOf(name))) hosts.files.push({ host: HOST, path: name, content: swappedCopy(name), mode: EXECUTABLE_MODE });
  }
};

describe("place-ansiwise: the engine held against its digests", () => {
  // THE PIN SAYS WHICH RELEASE IS FETCHED, AND NOT WHICH BYTES ARRIVE. The asset planted here answers
  // --version with the pin, exactly as a replaced one built to pass would, so the `--version`
  // read-back cannot see it: only the digest the platform repository states can. Run twice, planted and not,
  // so the refusal is shown to come from the digest and from nothing else about the run.
  for (const planted of [true, false]) {
    it(`places an asset that answers the pin only at the digest the platform repository states — ${planted ? "a planted asset" : "the released asset"}`, async () => {
      const hosts = scriptedHosts();
      const h = await makeHarness({ hosts });
      const url = `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_TOOL}-${ANSIWISE_PIN}-linux-x64`;
      if (planted) h.releases.serves.set(url, Buffer.from(`#!ansiwise\n${ANSIWISE_TOOL} ${ANSIWISE_PIN}\n# swapped\n`, "utf8"));
      const run = placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, planted ? "run_place_swapped" : "run_place_released", []));
      if (planted) {
        await expect(run).rejects.toThrow(
          new RegExp(`served bytes whose SHA-256 is [0-9a-f]{64}, and the platform repository states ${ansiwiseDigestMap(ANSIWISE_PIN).get(`${ANSIWISE_TOOL}-${ANSIWISE_PIN}-linux-x64`)} for ${ANSIWISE_TOOL}-`),
        );
        expect(transferred(hosts), "a swapped asset reached the machine").toHaveLength(0);
      } else {
        await run;
        expect(transferred(hosts).map((f) => f.path)).toEqual([ANSIWISE_TOOL, ANSIWISE_REST_TOOL]);
      }
    });
  }

  it("writes nothing when the digest file names only one of the two assets, and fetches nothing", async () => {
    const hosts = scriptedHosts();
    const onlyOne = ansiwiseDigests(ANSIWISE_PIN).split("\n").filter((l) => l.endsWith(`  ${ANSIWISE_TOOL}-${ANSIWISE_PIN}-linux-x64`)).join("\n") + "\n";
    const h = await makeHarness({ hosts, ansiwiseDigests: onlyOne });
    await expect(placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_one_digest", [])))
      .rejects.toThrow(/states no SHA-256 for ansiwise-rest-/);
    expect(h.releases.read, "an asset was fetched before every asset had a digest").toEqual([]);
    expect(transferred(hosts), "half of the engine reached the machine").toHaveLength(0);
  });

  it("writes neither executable when the second one differs from its digest", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const url = `https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_REST_TOOL}-${ANSIWISE_PIN}-linux-x64`;
    h.releases.serves.set(url, Buffer.from(`#!ansiwise\n${ANSIWISE_REST_TOOL} ${ANSIWISE_PIN}\n# swapped\n`, "utf8"));
    await expect(placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_second_swapped", [])))
      .rejects.toThrow(/served bytes whose SHA-256 is [0-9a-f]{64}, and the platform repository states/);
    expect(transferred(hosts), "the first executable was written before the second was held").toHaveLength(0);
  });

  it("refuses a pin the digest file states nothing for, before fetching anything", async () => {
    // The digests of another release: the file and the pin came apart, which is what a pin written
    // without its release leaves behind. Nothing is fetched, because nothing fetched could be held.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts, ansiwiseDigests: ansiwiseDigests("0.4.1") });
    await expect(placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_place_undigested", [])))
      .rejects.toThrow(new RegExp(`states no SHA-256 for ${ANSIWISE_TOOL}-${ANSIWISE_PIN.replace(/\./g, "\\.")}-linux-x64`));
    expect(h.releases.read, "an asset was fetched that no digest could hold").toEqual([]);
    expect(transferred(hosts)).toHaveLength(0);
  });
  it("installs onto the path only what this run placed, and leaves an executable at the pin in both places alone", async () => {
    // ansiwise answers the pin at home and on the path, and its home copy is not the release's bytes;
    // ansiwise-rest has drifted. Only ansiwise-rest is placed, so the unhashed home copy of ansiwise
    // never goes onto the path, and the path keeps the copy it had.
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, digests: ansiwiseDigestMap(ANSIWISE_PIN), elevationPassword: ELEVATION_PASSWORD };
    const machine = await sessionMachine(hosts, []);
    await machine.putFile(ANSIWISE_TOOL, Buffer.from(`#!ansiwise\n${ANSIWISE_TOOL} ${ANSIWISE_PIN}\n# never hashed\n`, "utf8"), EXECUTABLE_MODE);
    const genuine = assetBytes(ANSIWISE_TOOL, ANSIWISE_PIN).toString("utf8");
    hosts.files.push({ host: "10.1.1.11", path: `${ON_PATH}${ANSIWISE_TOOL}`, content: genuine, mode: EXECUTABLE_MODE });

    await placeAnsiwise(await sessionMachine(hosts, []), read, request);

    expect(releases.read).toEqual([`https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${ANSIWISE_REST_TOOL}-${ANSIWISE_PIN}-linux-x64`]);
    expect(hosts.log.filter((act) => act.command.startsWith("sudo -S install ")).map((act) => act.command.split(" ").at(-1)))
      .toEqual([`${PATH_HOME}${ANSIWISE_REST_TOOL}`]);
    expect(onPath(hosts).filter((f) => f.path === ANSIWISE_TOOL).at(-1)?.content).toBe(genuine);
  });

  it("places an executable whose path answers the pin while its home does not", async () => {
    // A master whose path copies regenerate-driver.sh moved to the pin (it writes /usr/local/bin
    // only) while the home still carries an earlier placement. The home half of the decision is what
    // places it again.
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, digests: ansiwiseDigestMap(ANSIWISE_PIN), elevationPassword: ELEVATION_PASSWORD };
    const machine = await sessionMachine(hosts, []);
    for (const name of ANSIWISE_EXECUTABLES) {
      await machine.putFile(name, assetBytes(name, "0.0.9"), EXECUTABLE_MODE);
      hosts.files.push({ host: "10.1.1.11", path: `${ON_PATH}${name}`, content: assetBytes(name, ANSIWISE_PIN).toString("utf8"), mode: EXECUTABLE_MODE });
    }
    const already = hosts.files.length;

    const verdict = await placeAnsiwise(await sessionMachine(hosts, []), read, request);

    expect(verdict).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(transferred(hosts, already).map((f) => f.path)).toEqual([...ANSIWISE_EXECUTABLES]);
  });

  it("never installs a home copy that answers the pin and is not the release's bytes", async () => {
    // The state an account holder can make without root: a file in the account's own home that
    // answers the pin. Before the path is written it is replaced by bytes this run held, so what
    // root installs is the release's and not the planted copy.
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, digests: ansiwiseDigestMap(ANSIWISE_PIN), elevationPassword: ELEVATION_PASSWORD };
    const planted = `#!ansiwise\n${ANSIWISE_TOOL} ${ANSIWISE_PIN}\n# planted by the account\n`;

    const machine = await sessionMachine(hosts, []);
    await machine.putFile(ANSIWISE_TOOL, Buffer.from(planted, "utf8"), EXECUTABLE_MODE);
    await machine.putFile(ANSIWISE_REST_TOOL, assetBytes(ANSIWISE_REST_TOOL, ANSIWISE_PIN), EXECUTABLE_MODE);

    await placeAnsiwise(await sessionMachine(hosts, []), read, request);

    const installed = onPath(hosts).find((f) => f.path === ANSIWISE_TOOL);
    expect(installed?.content, "the planted home copy reached the path").toBe(assetBytes(ANSIWISE_TOOL, ANSIWISE_PIN).toString("utf8"));
  });
});

describe("place-ansiwise: what root installed, read back off the path", () => {
  // THE WINDOW THE TRANSFER CANNOT CLOSE: `install` reads the home copy when it runs, and the account
  // can write that copy in between. Each machine below makes a state a process running as that
  // account can make, and each test goes red without the read-back or the digest it names.

  it("refuses a home copy swapped for the install even where it is put back right after, because the path is read", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_TOOL]);
    const machine = await machineWith(hosts, async (line, run) => {
      swap(line);
      const done = await run();
      if (line.startsWith(installOf(ANSIWISE_TOOL))) {
        hosts.files.push({ host: HOST, path: ANSIWISE_TOOL, content: genuine(ANSIWISE_TOOL), mode: EXECUTABLE_MODE });
      }
      return done;
    });

    await expect(placeAnsiwise(machine, read, request))
      .rejects.toThrow(new RegExp(`${PATH_HOME}${ANSIWISE_TOOL} on .* hashes to [0-9a-f]{64} after the install, .* it was taken off the path again`));
    expect(lastOnPath(hosts, ANSIWISE_TOOL), "the swapped copy stayed on the path").toBeUndefined();
    // Taken off as root, with the password on stdin and nowhere in the command.
    const removal = hosts.log.find((act) => act.command === `sudo -S rm -f ${PATH_HOME}${ANSIWISE_TOOL}`);
    expect(removal?.stdin?.toString("utf8")).toBe(`${ELEVATION_PASSWORD}\n`);
  });

  it("installs the second executable only once the first is read back, so a refusal leaves no swapped copy on the path", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, ANSIWISE_EXECUTABLES);
    const machine = await machineWith(hosts, (line, run) => { swap(line); return run(); });

    await expect(placeAnsiwise(machine, read, request)).rejects.toThrow(new RegExp(`${PATH_HOME}${ANSIWISE_TOOL} on .* hashes to`));
    for (const name of ANSIWISE_EXECUTABLES) expect(lastOnPath(hosts, name), `a swapped ${name} stayed on the path`).toBeUndefined();

    expect(await placeAnsiwise(await sessionMachine(hosts, []), read, request)).toEqual({ version: ANSIWISE_PIN, placed: true });
    for (const name of ANSIWISE_EXECUTABLES) expect(lastOnPath(hosts, name)).toBe(genuine(name));
  });

  it("reads back the second executable as well, and takes off only that one", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_REST_TOOL]);
    const machine = await machineWith(hosts, (line, run) => { swap(line); return run(); });

    await expect(placeAnsiwise(machine, read, request))
      .rejects.toThrow(new RegExp(`${PATH_HOME}${ANSIWISE_REST_TOOL} on .* hashes to [0-9a-f]{64} after the install`));
    expect(lastOnPath(hosts, ANSIWISE_REST_TOOL)).toBeUndefined();
    expect(lastOnPath(hosts, ANSIWISE_TOOL), "the first executable, read back and held, was taken off too").toBe(genuine(ANSIWISE_TOOL));
  });

  it("leaves no unread copy on the path when the account also breaks the install after it", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_TOOL]);
    const machine = await machineWith(hosts, (line, run) => {
      swap(line);
      // The account deletes its ~/ansiwise-rest just before root installs it, so that install fails.
      if (line.startsWith(installOf(ANSIWISE_REST_TOOL))) {
        hosts.files = hosts.files.filter((f) => !(f.host === HOST && f.path === ANSIWISE_REST_TOOL));
      }
      return run();
    });

    await expect(placeAnsiwise(machine, read, request)).rejects.toThrow(new RegExp(`${PATH_HOME}${ANSIWISE_TOOL} on .* hashes to`));
    expect(lastOnPath(hosts, ANSIWISE_TOOL), "the swapped ansiwise stayed on the path").toBeUndefined();
  });

  it("refuses a copy whose read-back could not be read, and names the reading rather than a swap", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const machine = await machineWith(hosts, (line, run) =>
      (line.startsWith("sha256sum ") ? Promise.resolve({ code: 127, stdout: "" }) : run()));

    const refusal = await placeAnsiwise(machine, read, request).then(() => "no refusal", (e: Error) => e.message);
    expect(refusal).toContain(`${PATH_HOME}${ANSIWISE_TOOL} on ${FIRST_INSTALL_FQDN} could not be read back after the install (sha256sum exit 127)`);
    expect(refusal).not.toMatch(/hashes to/);
    expect(lastOnPath(hosts, ANSIWISE_TOOL), "a copy nobody read stayed on the path").toBeUndefined();
  });

  it("records a copy that failed its digest even where the removal never returns", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_TOOL]);
    const said: string[] = [];
    const machine = await machineWith(hosts, (line, run) => {
      swap(line);
      return line.startsWith("sudo -S rm -f ") ? Promise.reject(new Error("the session ended before the removal")) : run();
    }, said);

    await expect(placeAnsiwise(machine, read, request)).rejects.toThrow("the session ended before the removal");
    expect(said.join("\n")).toMatch(new RegExp(`${PATH_HOME}${ANSIWISE_TOOL} on .* hashes to [0-9a-f]{64} after the install`));
  });

  it("says a copy that could not be taken off is still there, and the next run places over it", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_TOOL]);
    const machine = await machineWith(hosts, (line, run) => {
      swap(line);
      return line.startsWith("sudo -S rm -f ") ? Promise.resolve({ code: 1, stdout: "" }) : run();
    });

    await expect(placeAnsiwise(machine, read, request))
      .rejects.toThrow("it could not be taken off the path again (exit 1), so it is still there until the next placement places over it");
    expect(lastOnPath(hosts, ANSIWISE_TOOL)).toBe(swappedCopy(ANSIWISE_TOOL));
    expect(await placeAnsiwise(await sessionMachine(hosts, []), read, request)).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(lastOnPath(hosts, ANSIWISE_TOOL)).toBe(genuine(ANSIWISE_TOOL));
  });

  it("places again over a copy left on the path when the session ended before its read-back", async () => {
    // THE WINDOW THIS DOES NOT CLOSE: the installed copy stands unread under the name root runs until
    // the next placement hashes it.
    const hosts = scriptedHosts();
    const { read, request } = placement();
    const swap = swapAtInstall(hosts, [ANSIWISE_TOOL]);
    let installed = false;
    const machine = await machineWith(hosts, (line, run) => {
      swap(line);
      if (line.startsWith("sudo -S install ")) installed = true;
      return installed && line.startsWith("sha256sum ") ? Promise.reject(new Error("the session ended before the read-back")) : run();
    });

    await expect(placeAnsiwise(machine, read, request)).rejects.toThrow("the session ended before the read-back");
    expect(lastOnPath(hosts, ANSIWISE_TOOL)).toBe(swappedCopy(ANSIWISE_TOOL));
    expect(await placeAnsiwise(await sessionMachine(hosts, []), read, request)).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(lastOnPath(hosts, ANSIWISE_TOOL)).toBe(genuine(ANSIWISE_TOOL));
  });

  /** A machine whose home and path both carry the release's bytes at the pin. */
  async function placedMachine(hosts: HostsScript, onPathOf: (name: string) => string = genuine): Promise<void> {
    const machine = await sessionMachine(hosts, []);
    for (const name of ANSIWISE_EXECUTABLES) {
      await machine.putFile(name, assetBytes(name, ANSIWISE_PIN), EXECUTABLE_MODE);
      hosts.files.push({ host: HOST, path: `${ON_PATH}${name}`, content: onPathOf(name), mode: EXECUTABLE_MODE });
    }
  }

  for (const swapped of ANSIWISE_EXECUTABLES) {
    it(`places again over a path copy that answers the pin and is not the release's bytes, and says why — ${swapped}`, async () => {
      const hosts = scriptedHosts();
      const { releases, read, request } = placement();
      await placedMachine(hosts, (name) => (name === swapped ? swappedCopy(name) : genuine(name)));

      const said: string[] = [];
      expect(await placeAnsiwise(await sessionMachine(hosts, said), read, request)).toEqual({ version: ANSIWISE_PIN, placed: true });
      expect(said.join("\n")).toContain(`${PATH_HOME}${swapped} answers ${ANSIWISE_PIN} and does not hash to its stated SHA-256`);
      expect(releases.read).toEqual([`https://downloads.example.invalid/ansiwise/${ANSIWISE_PIN}/${swapped}-${ANSIWISE_PIN}-linux-x64`]);
      expect(lastOnPath(hosts, swapped)).toBe(genuine(swapped));
    });
  }

  it("places again over a path copy with the release's bytes that does not answer the pin", async () => {
    // The release's bytes that do not run from the path, as a copy that lost its execute bit answers.
    // The digest alone would call it placed, so the version half of the decision is what places it.
    const hosts = scriptedHosts();
    const { read, request } = placement();
    await placedMachine(hosts);
    let asked = false;
    const said: string[] = [];
    const honest = await sessionMachine(hosts, said);
    const machine: PlacementMachine = {
      ...honest,
      run: (argv, o) => {
        if (!asked && argv.join(" ") === `${PATH_HOME}${ANSIWISE_TOOL} --version`) {
          asked = true;
          return Promise.resolve({ code: 126, stdout: "" });
        }
        return honest.run(argv, o);
      },
    };

    expect(await placeAnsiwise(machine, read, request)).toEqual({ version: ANSIWISE_PIN, placed: true });
    expect(said.join("\n")).toContain(`${PATH_HOME}${ANSIWISE_TOOL} answers nothing)`);
  });

  it("refuses a path copy that runs and cannot be hashed, and places nothing over it", async () => {
    const hosts = scriptedHosts();
    const { read, request } = placement();
    await placedMachine(hosts);
    const machine = await machineWith(hosts, (line, run) =>
      (line.startsWith("sha256sum ") ? Promise.resolve({ code: 127, stdout: "" }) : run()));

    await expect(placeAnsiwise(machine, read, request)).rejects.toThrow(
      `${PATH_HOME}${ANSIWISE_TOOL} on ${FIRST_INSTALL_FQDN} answers ${ANSIWISE_PIN}, and sha256sum could not read it (exit 127)`,
    );
    expect(hosts.log.some((act) => act.command.startsWith("sudo ")), "something was installed or removed").toBe(false);
    for (const name of ANSIWISE_EXECUTABLES) expect(lastOnPath(hosts, name)).toBe(genuine(name));
  });
});
