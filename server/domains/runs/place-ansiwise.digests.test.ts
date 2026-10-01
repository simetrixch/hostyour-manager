import { describe, it, expect, afterEach } from "vitest";
import {
  makeHarness, disposeHarnesses, scriptedHosts, ELEVATION_PASSWORD,
  ANSIWISE_PIN, ANSIWISE_DOWNLOAD_URL, ansiwiseDigestMap, ansiwiseDigests,
} from "./deploy-slave.fixture.ts";
import { assetBytes, ScriptedReleases, ON_PATH } from "./deploy-slave.placement.fixture.ts";
import { ports, placeCtx, target, transferred, onPath, sessionMachine } from "./place-ansiwise.fixture.ts";
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

describe("place-ansiwise: the engine held against its digests", () => {
  // THE PIN SAYS WHICH RELEASE IS FETCHED, AND NOT WHICH BYTES ARRIVE. The asset planted here answers
  // --version with the pin, exactly as a replaced one built to pass would, so the read-back above
  // cannot see it: only the digest the platform repository states can. Run twice, planted and not,
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
  it("takes a home copy swapped between the transfer and the install off the path again, and refuses the run", async () => {
    // The window the transfer cannot close: `install` reads the home copy when it runs, and the
    // account can write it in between. The machine below swaps ~/ansiwise for a copy that answers the
    // pin at the moment root installs it, which is the state a process running as that account can make.
    const hosts = scriptedHosts();
    const releases = new ScriptedReleases();
    const read = { read: (url: string) => releases.get(url, { signal: new AbortController().signal }) };
    const request = { version: ANSIWISE_PIN, downloadUrl: ANSIWISE_DOWNLOAD_URL, digests: ansiwiseDigestMap(ANSIWISE_PIN), elevationPassword: ELEVATION_PASSWORD };
    const swapped = `#!ansiwise\n${ANSIWISE_TOOL} ${ANSIWISE_PIN}\n# swapped before the install\n`;
    const honest = await sessionMachine(hosts, []);
    const racing: PlacementMachine = {
      ...honest,
      run: async (argv, o) => {
        if (argv.join(" ").startsWith(`sudo -S install -m 755 ${BOOTSTRAP_HOME}${ANSIWISE_TOOL} `)) {
          hosts.files.push({ host: "10.1.1.11", path: ANSIWISE_TOOL, content: swapped, mode: EXECUTABLE_MODE });
        }
        return honest.run(argv, o);
      },
    };

    await expect(placeAnsiwise(racing, read, request))
      .rejects.toThrow(new RegExp(`${PATH_HOME}${ANSIWISE_TOOL} on .* hashes to [0-9a-f]{64} after the install, .* it was taken off the path again`));
    expect(onPath(hosts).filter((f) => f.path === ANSIWISE_TOOL).at(-1)?.content, "the swapped copy stayed on the path")
      .not.toBe(swapped);
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
