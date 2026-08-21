import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers } from "../../db/schema/inventory.ts";
import {
  makeHarness, disposeHarnesses, scriptedHosts, SLAVE_ID, ANSIWISE_PIN, ANSIWISE_CATALOG_URL,
  type HostsScript,
} from "./deploy-slave.fixture.ts";
import { ELEVATION, PORTS_URL, ports, placeCtx, target, placingScripts } from "./place-ansiwise.fixture.ts";
import { placeAnsiwiseStep, enableAnsiwiseServiceStep } from "./defs/deploy-slave.ts";
import {
  parseProbe, placement, probeScript,
  ANSIWISE_BINARY_LINK, ANSIWISE_SERVICE_UNIT, ANSIWISE_SERVICE_PORT,
  CATALOG_CHECKOUT, SERVICE_TOKEN_FILE,
} from "./defs/place-ansiwise.ts";

afterEach(() => disposeHarnesses());

// hm#22: a first installation ends with a machine SERVING, and not with a command a person types.
// The unit and the switch stay the binary's own act — what is added is a caller for it that is not a
// person: the same placement, run again once the join gave the machine an address to stand on.
describe("enable-ansiwise-service", () => {
  /** A machine that has been through everything before this step in the list: placed, and carrying
   *  the token file run-deploy-gitops writes. */
  function placedHosts(over: Partial<HostsScript> = {}): HostsScript {
    return scriptedHosts({
      placedBinary: ANSIWISE_PIN, platformCheckout: true, catalogCheckout: true, programs: true,
      missingCommands: [], ...over,
    });
  }

  it("leaves the machine enabled and running without anybody typing a command — and a SECOND run does nothing", async () => {
    const hosts = placedHosts();
    const h = await makeHarness({ hosts });
    const first: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc1", first));

    expect(hosts.serviceEnabled, "the machine was left with no service — a person still has to finish the installation").toBe(true);
    expect(hosts.serviceActive).toBe(true);
    // The address is the server row's tailnet address with the port the manager dials — one value,
    // stated by the side that will dial it, not read back off the machine.
    const script = placingScripts(hosts)[0] ?? "";
    expect(script).toContain(`--listen "100.64.0.11:${ANSIWISE_SERVICE_PORT}"`);
    // And the sentence names what the UNIT starts, read off the machine: the version its command
    // carries and the address on that command's --listen, not the two values the request held.
    expect(first.some((l) => l.includes(
      `${ANSIWISE_SERVICE_UNIT} is enabled and running, starting ansiwise ${ANSIWISE_PIN} on 100.64.0.11:${ANSIWISE_SERVICE_PORT}`,
    ))).toBe(true);

    const second: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc2", second));
    expect(placingScripts(hosts), "the second run put a placing script on a machine that already served").toHaveLength(1);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
  });

  /** A machine that is already SERVING: the unit up, and its command naming a version and an
   *  address. What a redeploy meets, and what a first installation never is. */
  function servingHosts(over: { version: string; listen: string }): HostsScript {
    return placedHosts({
      placedBinary: over.version,
      serviceEnabled: true, serviceActive: true,
      serviceExecVersion: over.version, serviceExecListen: over.listen,
      serviceRunningVersion: over.version,
    });
  }

  it("RE-INSTALLS the unit when the pin moved, and the machine ends up starting the new version", async () => {
    // The upgrade. The pin moved, so the placement writes /usr/local/bin/ansiwise-0.4.2 and repoints
    // the link — and the unit still names ansiwise-0.0.1-old, which is still on disk and still what
    // `Restart=always` brings back. A placement that asked only whether the service is up would leave
    // it there and report the new version serving. So the unit is measured by what it STARTS, and the
    // machine is left with the unit, and the process, on the version that was just placed.
    const hosts = servingHosts({ version: "0.0.1-old", listen: `100.64.0.11:${ANSIWISE_SERVICE_PORT}` });
    const h = await makeHarness({ hosts });
    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_up", log));

    expect(placingScripts(hosts)[0], "the pin moved and the unit was left pointing at the old file").toContain("install-service");
    expect(hosts.serviceExecVersion, "the unit still starts the version it started before the placement").toBe(ANSIWISE_PIN);
    expect(hosts.serviceRunningVersion, "the unit was rewritten and the OLD binary is still the process serving").toBe(ANSIWISE_PIN);
    // What it said it was placing names what the unit was on, and the closing sentence names what
    // the unit is on now — neither of them the version the request happened to hold.
    expect(log.some((l) => l.startsWith("placing on s1") && l.includes("starting ansiwise 0.0.1-old"))).toBe(true);
    const closing = log.find((l) => l.includes("carries ansiwise")) ?? "";
    expect(closing).toContain(`${ANSIWISE_SERVICE_UNIT} is enabled and running, starting ansiwise ${ANSIWISE_PIN} on 100.64.0.11:${ANSIWISE_SERVICE_PORT}`);
    expect(closing, "it reported the machine serving a version its unit does not name").not.toContain("0.0.1-old");
  });

  it("RE-INSTALLS the unit when it stands on an address the machine no longer holds", async () => {
    // The rejoin hands the host a fresh private address (tailnet.kit.ts) and nothing rewrites the
    // unit, so the surface goes on binding the one it used to hold while the manager dials the new
    // one. Enabled and running are both true of that machine, which is why neither is the question.
    const hosts = servingHosts({ version: ANSIWISE_PIN, listen: "100.64.0.9:9953" });
    const h = await makeHarness({ hosts });
    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_addr", log));

    expect(placingScripts(hosts), "the unit stood on a stale address and was left standing on it").toHaveLength(1);
    expect(placingScripts(hosts)[0] ?? "").toContain("install-service");
    expect(hosts.serviceExecListen).toBe(`100.64.0.11:${ANSIWISE_SERVICE_PORT}`);
    expect(log.some((l) => l.includes("100.64.0.9:9953")), "it never said which address the unit was on").toBe(true);
  });

  it("leaves a machine already serving the pinned version on the stated address alone", async () => {
    const hosts = servingHosts({ version: ANSIWISE_PIN, listen: `100.64.0.11:${ANSIWISE_SERVICE_PORT}` });
    const h = await makeHarness({ hosts });
    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_noop", log));
    expect(placingScripts(hosts), "it re-installed a unit that was already starting the right thing").toHaveLength(0);
    expect(log.some((l) => l.includes("nothing to place"))).toBe(true);
  });

  it("places ONLY the service on a machine that already carries the other three", async () => {
    // The measurement is what makes this the same mechanism rather than a second one: everything the
    // first step left standing is found standing, so nothing is fetched and nothing is cloned.
    const hosts = placedHosts();
    const h = await makeHarness({ hosts });
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc3", []));
    const script = placingScripts(hosts)[0] ?? "";
    expect(script).not.toContain("curl -fsSL");
    expect(script).not.toContain("clone");
    expect(script).not.toContain("apt-get");
    expect(script).toContain("install-service");
  });

  // THE COUNTER-PROBE hm#22 names: a machine whose service was never enabled, observed REFUSED by
  // what comes after it rather than reported ready. install-service exits zero — it wrote the unit
  // and switched it on — and the service manager then says the machine is not running it, which is
  // what a bind to an address the machine does not hold looks like. The verdict is read off the
  // machine a second time, so the placing script's own claim cannot pass for one.
  it("refuses a machine whose service did not come up, and never reports it ready", async () => {
    const hosts = placedHosts({ serviceStartsAfterInstall: false });
    const h = await makeHarness({ hosts });
    const log: string[] = [];
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc4", log));
    await expect(run).rejects.toThrow(new RegExp(`${ANSIWISE_SERVICE_UNIT} on s1 is enabled and NOT running`));
    await expect(run).rejects.toThrow(/journalctl -u ansiwise\.service/);
    expect(log.some((l) => l.includes("is enabled and running")), "it announced a machine that serves nothing").toBe(false);
  });

  it("refuses a machine that carries no token file, naming the row that writes it", async () => {
    // The one thing install-service cannot invent. A machine that has not been through deploy-gitops
    // has no minted token, and a unit enabled without one comes up failed at every boot with nothing
    // but a journal saying so — so the refusal comes BEFORE install-service is run at all.
    const hosts = placedHosts({ serviceTokenFile: false });
    const h = await makeHarness({ hosts });
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5", []));
    await expect(run).rejects.toThrow(new RegExp(`carries no ${SERVICE_TOKEN_FILE}`));
    await expect(run).rejects.toThrow(/deploy-gitops/);
    expect(hosts.serviceEnabled, "it enabled a unit that cannot read its own credential").toBe(false);
  });

  it("refuses a server row with no tailnet address rather than putting the surface anywhere else", async () => {
    // The manager presents the service token in a plain HTTP header, so where the surface stands
    // decides whether that credential crosses a wire somebody else can read. A row without the
    // address means the join or the reading that records it did not happen — and nothing is asked of
    // the machine before that is said.
    const hosts = placedHosts();
    const h = await makeHarness({ hosts });
    h.db.db.update(servers).set({ tailnetHost: null }).where(eq(servers.id, SLAVE_ID)).run();
    await expect(enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6", [])))
      .rejects.toThrow(/carries no tailnet address/);
    // And it says where the value comes from. The column is written when the server is created and by
    // nothing else, so a refusal pointing at the join or the membership reading sends the operator to
    // a repair that cannot fill it.
    await expect(enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6b", [])))
      .rejects.toThrow(/TYPED on the inventory row/);
    expect(placingScripts(hosts), "it reached the machine before finding out where the surface would stand").toHaveLength(0);
  });

  it("refuses a tailnet NAME on the row, naming the column and the shape the binary takes", async () => {
    // servers.tailnetHost is `z.string().min(1)` and its other reader — the cluster map's apiHost —
    // takes a name, so a MagicDNS name is legal on the row and refused by ServiceInstallation, which
    // reads the host as four numbers. The operator is told which of the two shapes he wrote, here,
    // before anything is asked of the machine.
    const hosts = placedHosts();
    const h = await makeHarness({ hosts });
    h.db.db.update(servers).set({ tailnetHost: "s1.tail1234.ts.net" }).where(eq(servers.id, SLAVE_ID)).run();
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6c", []));
    await expect(run).rejects.toThrow(/carries the tailnet address "s1\.tail1234\.ts\.net"/);
    await expect(run).rejects.toThrow(/four numbers/);
    expect(placingScripts(hosts), "it reached the machine with an address it would be refused on").toHaveLength(0);
  });

  it("leaves the unit alone where no address was stated — the placement at the head of the list", async () => {
    // A machine at its first installation has no tailnet address, so place-ansiwise states none: it
    // neither asks the service manager for a verdict nor writes anything about a unit. The service
    // is placed by the step that runs after the join, and by nothing earlier.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc7", []));
    expect(placingScripts(hosts)[0]).not.toContain("install-service");
    expect(hosts.serviceEnabled).toBe(false);
  });
});

// The script that reaches the machine, composed. What is held down is that it is a CALL and not a
// unit: deploy-gitops.yaml states the rule and it is right, so what this places has to be an
// invocation of the one thing that knows the started command's option names.
describe("the service part of the placing script", () => {
  it("asks the service manager the two questions separately — enabled and running are not one fact", () => {
    // A unit that is enabled and dead answers nothing until the next boot; one that runs and is not
    // enabled answers now and is gone after a restart. Read as one fact, both look like a machine
    // with a surface on it, and hm#22 asks for the machine that is BOTH.
    const script = probeScript();
    expect(script).toContain(`systemctl is-enabled --quiet ${ANSIWISE_SERVICE_UNIT}`);
    expect(script).toContain(`systemctl is-active --quiet ${ANSIWISE_SERVICE_UNIT}`);
    const dead = parseProbe("BINARY 0.4.2\nPLATFORM present\nCATALOG present\nPROGRAMS present\nSERVICE enabled\nSERVICE not-active\nSERVICE_EXEC ExecStart=\nPROBED");
    expect(dead.service).toEqual({ enabled: true, active: false });
    const unenabled = parseProbe("BINARY 0.4.2\nPLATFORM present\nCATALOG present\nPROGRAMS present\nSERVICE not-enabled\nSERVICE active\nSERVICE_EXEC ExecStart=\nPROBED");
    expect(unenabled.service).toEqual({ enabled: false, active: true });
  });

  it("asks the unit what it STARTS, and reads the version and the address out of the answer", () => {
    // ExecStart names the VERSIONED file — ansiwise-cli ServiceInstallation.command puts the
    // executable first and bin/ansiwise.dart hands it Platform.resolvedExecutable — so a unit that
    // is up says which binary comes back at the next restart and on which address. Neither follows
    // from is-enabled or is-active, and both are what a placement's own sentence claims.
    expect(probeScript()).toContain(`systemctl show -p ExecStart ${ANSIWISE_SERVICE_UNIT}`);
    const shown = "SERVICE_EXEC ExecStart={ path=/usr/local/bin/ansiwise-0.0.1-old ; " +
      "argv[]=/usr/local/bin/ansiwise-0.0.1-old serve --listen 100.64.0.9:9953 --config ansiwise.yaml ; pid=7 }";
    const stale = parseProbe(`BINARY 0.4.2\nPLATFORM present\nCATALOG present\nPROGRAMS present\nSERVICE enabled\nSERVICE active\n${shown}\nPROBED`);
    expect(stale.service).toEqual({ enabled: true, active: true, version: "0.0.1-old", listen: "100.64.0.9:9953" });
    // A unit the service manager does not know, and a file under a name this mechanism did not write.
    const none = parseProbe("BINARY absent\nPLATFORM absent\nCATALOG absent\nPROGRAMS absent\nSERVICE not-enabled\nSERVICE not-active\nSERVICE_EXEC ExecStart=\nPROBED");
    expect(none.service).toEqual({ enabled: false, active: false });
    const foreign = parseProbe("BINARY 0.4.2\nPLATFORM present\nCATALOG present\nPROGRAMS present\nSERVICE enabled\nSERVICE active\nSERVICE_EXEC ExecStart={ path=/opt/ansiwise ; argv[]=/opt/ansiwise serve ; pid=7 }\nPROBED");
    expect(foreign.service.version).toBe("unversioned");
  });

  it("INVOKES install-service and writes no unit — the started command is the binary's own to compose", () => {
    // The rule digita-deploy ansiwise/programs/deploy-gitops.yaml states in its own words, held down
    // here: what reaches the machine is a CALL, with install-service's own option names on it and
    // nothing that looks like a unit. A second spelling of `ExecStart`, of `serve`, or of the unit's
    // required lines anywhere in this script would be a copy of an interface kept by somebody who
    // cannot see it change.
    const script = placement({
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
      listen: "100.64.0.11:9953",
      place: { commands: false, binary: false, platform: false, catalog: false, service: true },
    }).script;
    expect(script).toContain(`"/usr/local/bin/ansiwise-0.4.2" install-service`);
    expect(script).toContain(`--listen "100.64.0.11:9953"`);
    expect(script).toContain(`--service-token-file "${SERVICE_TOKEN_FILE}"`);
    expect(script).toContain(`--programs "${CATALOG_CHECKOUT}/ansiwise/programs"`);
    expect(script).toContain("--answers -");
    // And the restart after it, because install-service ends at `systemctl enable --now` and `--now`
    // does nothing to a unit that is already running: without this the unit says the new version and
    // the process serving is still the old file.
    expect(script).toContain(`sudo -n systemctl restart ${ANSIWISE_SERVICE_UNIT}`);
    // NOT named, because the binary already decides them and the working directory below makes both
    // land right: --config defaults to ansiwise.yaml beside it, --runs to /var/lib/ansiwise/runs.
    // Writing either here would be a copy of a value that lives in ansiwise-core.
    expect(script).not.toContain("--config");
    expect(script).not.toContain("--runs");
    // The working directory install-service takes the service's own from.
    expect(script).toContain(`cd "${CATALOG_CHECKOUT}"`);
    for (const composed of ["ExecStart", "WantedBy", "Restart=always", "KillMode", "[Service]", "systemctl enable"]) {
      expect(script, `the placing script composes "${composed}" itself — that is the binary's to write`).not.toContain(composed);
    }
    // The VERSIONED file and not the link: install-service refuses when the file it was started from
    // and the executable it resolved to differ, and the link resolves to the versioned one.
    expect(script).not.toContain(`"${ANSIWISE_BINARY_LINK}" install-service`);
  });

  it("reads the service token on the machine and refuses a machine that has none — the value never travels", () => {
    // The token is minted by deploy-gitops into <stage>/manager-host/ansiwise and written to
    // SERVICE_TOKEN_FILE by its file_from_vault row. install-service is told it on standard input,
    // and the script reads it out of that file: the manager never holds it, so there is no second
    // place it could be minted, copied or logged. A machine that has not been through that program
    // is refused before install-service is run at all.
    const composed = placement({
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
      listen: "100.64.0.11:9953",
      place: { commands: false, binary: false, platform: false, catalog: false, service: true },
    });
    expect(composed.script).toContain(`sudo -n test -r "${SERVICE_TOKEN_FILE}"`);
    expect(composed.script).toContain('echo "NO_SERVICE_TOKEN"');
    expect(composed.script).toContain(`service_token=$(sudo -n cat "${SERVICE_TOKEN_FILE}")`);
    expect(composed.script).toContain('"$service_token"');
    // The envelope is built where the token is, and the elevation password rides the same standard
    // input it always did — read into a variable here because install-service needs it a second
    // time, in the envelope the installation's ansiwise.yaml (password_from_caller) asks for.
    expect(composed.script).toContain('{"answers":{"service_token":"%s"},"elevation_password":"%s"}');
    expect(composed.script).toContain("IFS= read -r ANSIWISE_ELEVATION");
    expect(composed.script).not.toContain(ELEVATION);
    expect(composed.stdin.toString("utf8")).toBe(`${ELEVATION}\n`);
  });

  it("refuses an address by naming the SHAPE, and leaves the range to the binary", () => {
    const base = {
      version: "0.4.2", downloadUrl: "https://x.example.invalid/0.4.2/ansiwise", repoUrl: PORTS_URL,
      branch: "s1.example.com", catalogUrl: ANSIWISE_CATALOG_URL, elevationPassword: ELEVATION, user: "ubuntu",
      place: { commands: false, binary: false, platform: false, catalog: false, service: true },
    };
    expect(() => placement({ ...base, listen: '100.64.0.11:9953"; rm -rf /' })).toThrow(/is not a shape install-service's --listen takes/);
    expect(() => placement({ ...base, listen: "" })).toThrow(/<a\.b\.c\.d>:<port>/);
    // A MagicDNS name is what the OTHER reader of servers.tailnetHost accepts (deploy-slave's
    // apiHost), so the refusal has to say which of the two shapes this one is short of rather than
    // only that the value is wrong.
    expect(() => placement({ ...base, listen: "s1.tail1234.ts.net:9953" })).toThrow(/four numbers and a port/);
    // A public address is a value of the right SHAPE and one the BINARY refuses, with the reason.
    // Composing a refusal for it here would be a second copy of a rule that lives there.
    expect(placement({ ...base, listen: "203.0.113.7:9953" }).script).toContain(`--listen "203.0.113.7:9953"`);
  });
});
