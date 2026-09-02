import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { servers } from "../../db/schema/inventory.ts";
import {
  makeHarness, disposeHarnesses, scriptedHosts, hostsFactory, ELEVATION_PASSWORD, SLAVE_ID, ANSIWISE_PIN,
  type HostsScript,
} from "./deploy-slave.fixture.ts";
import { assetBytes, SCRIPTED_HOME } from "./deploy-slave.placement.fixture.ts";
import { ports, placeCtx, target, commands, transferred } from "./place-ansiwise.fixture.ts";
import { placeAnsiwiseStep, enableAnsiwiseServiceStep } from "./defs/place-ansiwise.step.ts";
import {
  installServiceArgv, assertWord,
  ANSIWISE_EXECUTABLES, ANSIWISE_REST_TOOL, ANSIWISE_SERVICE_UNIT, ANSIWISE_SERVICE_PORT,
  BOOTSTRAP_HOME, EXECUTABLE_MODE, INSTALL_SERVICE_PROGRAM,
} from "./defs/place-ansiwise.ts";
import { CATALOG_CHECKOUT, CATALOG_CONFIG, CATALOG_PROGRAMS, SERVICE_TOKEN_FILE } from "./defs/machine-state.ts";

afterEach(() => disposeHarnesses());

// hm#22: a first installation ends with a machine SERVING, and not with a command a person types.
// The unit and the switch stay the BINARY's own act — what stands here is a caller for it that is not
// a person, and the one line of the act that is still this repository's: the restart.
//
// WHAT REACHES THE MACHINE IS AN ARGUMENT LIST, never a composed script — no `cd`, no pipeline into
// it, no `sed` escaping a password into JSON. What is sent is words, and the envelope rides
// standard input.

/** A machine that has been through everything before this step in the list: both executables at the
 *  pin, and the token file run-deploy-platform-services writes. */
async function placedMachine(hosts: HostsScript, version = ANSIWISE_PIN): Promise<number> {
  const session = await hostsFactory(hosts)({
    host: "10.1.1.11", port: 22, username: "ubuntu", auth: { kind: "key", privateKey: Buffer.from("k") },
  });
  const signal = new AbortController().signal;
  for (const name of ANSIWISE_EXECUTABLES) await session.putFile(name, assetBytes(name, version), EXECUTABLE_MODE, { signal });
  // Answered as WHERE the machine's own state ends: what a test planted is the machine, and what a
  // run writes after this index is what that run transferred. Clearing the record instead would make
  // the machine answer `--version` with nothing and turn every placed machine into a bare one.
  return hosts.files.length;
}

describe("enable-ansiwise-service", () => {
  it("leaves the machine enabled and running without anybody typing a command — and a SECOND run does nothing", async () => {
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    const first: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc1", first));

    expect(hosts.serviceEnabled, "the machine was left with no service — a person still has to finish the installation").toBe(true);
    expect(hosts.serviceActive).toBe(true);
    // The address is the server row's tailnet address with the port the manager dials — one value,
    // stated by the side that will dial it, never read back off the machine.
    expect(hosts.serviceExecListen).toBe(`100.64.0.11:${ANSIWISE_SERVICE_PORT}`);
    // And the unit starts the SERVING binary. install-service is a program of that one; the
    // deployment tool answers "no program is called install-service" and exits 64.
    expect(hosts.serviceExecPath).toBe(`${SCRIPTED_HOME}/${ANSIWISE_REST_TOOL}`);
    expect(first.some((l) => l.includes(`serves ${ANSIWISE_REST_TOOL} ${ANSIWISE_PIN} on 100.64.0.11:${ANSIWISE_SERVICE_PORT}`))).toBe(true);

    const second: string[] = [];
    hosts.log.length = 0;
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc2", second));
    expect(commands(hosts).some((c) => c.includes(INSTALL_SERVICE_PROGRAM)), "it re-installed a unit that was already starting the right thing").toBe(false);
    expect(second.some((l) => l.includes("nothing to place"))).toBe(true);
  });

  it("RE-INSTALLS the unit when the pin moved, and restarts it onto the file that was just written", async () => {
    // The upgrade, and the reason the restart is still here. The bootstrap writes the new bytes over
    // the file the unit names; a running service keeps the inode it started from, so the unit's own
    // command is unchanged, `--version` on that path now answers the NEW release, and the process
    // serving is still the old code. install-service ends at `systemctl enable --now`, which does
    // nothing to a unit that is already running. Only the restart moves it, and no step of the
    // framework restarts a unit (ansiwise-plugins#141).
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    const already = await placedMachine(hosts, "0.0.1-old");
    // A machine already serving that older release.
    hosts.serviceEnabled = true;
    hosts.serviceActive = true;
    hosts.serviceExecPath = `${SCRIPTED_HOME}/${ANSIWISE_REST_TOOL}`;
    hosts.serviceExecVersion = "0.0.1-old";
    hosts.serviceExecListen = `100.64.0.11:${ANSIWISE_SERVICE_PORT}`;
    hosts.serviceRunningVersion = "0.0.1-old";

    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_up", log));

    expect(transferred(hosts, already).map((f) => f.path), "the pin moved and the machine was left on the old release").toEqual([...ANSIWISE_EXECUTABLES]);
    expect(hosts.serviceExecVersion).toBe(ANSIWISE_PIN);
    expect(hosts.serviceRunningVersion, "the unit was rewritten and the OLD executable is still the process serving").toBe(ANSIWISE_PIN);
    expect(commands(hosts)).toContain(`sudo -S systemctl restart ${ANSIWISE_SERVICE_UNIT}`);
    expect(log.some((l) => l.includes("it carries 0.0.1-old"))).toBe(true);
  });

  it("RE-INSTALLS the unit when it stands on an address the machine no longer holds", async () => {
    // The rejoin hands the host a fresh private address (tailnet.kit.ts) and nothing rewrites the
    // unit, so the surface goes on binding the one it used to hold while the manager dials the new
    // one. Enabled and running are both true of that machine, which is why neither is the question.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    hosts.serviceEnabled = true;
    hosts.serviceActive = true;
    hosts.serviceExecPath = `${SCRIPTED_HOME}/${ANSIWISE_REST_TOOL}`;
    hosts.serviceExecVersion = ANSIWISE_PIN;
    hosts.serviceExecListen = "100.64.0.9:9953";
    hosts.serviceRunningVersion = ANSIWISE_PIN;

    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_addr", log));
    expect(hosts.serviceExecListen).toBe(`100.64.0.11:${ANSIWISE_SERVICE_PORT}`);
    expect(log.some((l) => l.includes("100.64.0.9:9953")), "it never said which address the unit was on").toBe(true);
  });

  it("sends install-service as an argument list, with the envelope on standard input", async () => {
    // The whole shape the issue asks for, read off what was SENT: one command, every word of it a
    // word, the option names install-service's own, and the two secrets on standard input where a
    // process listing cannot reach them.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc_argv", []));

    const installing = hosts.log.filter((l) => l.command.includes(INSTALL_SERVICE_PROGRAM));
    expect(installing).toHaveLength(1);
    expect(installing[0]?.command).toBe(
      installServiceArgv({ executable: `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, listen: `100.64.0.11:${ANSIWISE_SERVICE_PORT}` }).join(" "),
    );
    // The envelope: the token read off the machine and the password the run carries, neither of them
    // anywhere but on that command's standard input.
    const envelope = JSON.parse(installing[0]?.stdin?.toString("utf8") ?? "{}") as { answers: { service_token: string }; elevation_password: string };
    expect(envelope.answers.service_token).toBe(hosts.serviceToken);
    expect(envelope.elevation_password).toBe(ELEVATION_PASSWORD);
    for (const act of hosts.log) expect(act.command).not.toContain(ELEVATION_PASSWORD);
    for (const f of hosts.files) expect(f.content).not.toContain(ELEVATION_PASSWORD);
    // No shell reaches the machine here either: every command is words, and nothing is uploaded and
    // run. A composed script would `cd`, pipe a `printf` into the installer and `sed`-escape the
    // password into JSON — three shell constructs in one act.
    for (const command of commands(hosts)) {
      for (const word of command.split(" ")) expect(() => assertWord(word, "word"), command).not.toThrow();
      expect(command).not.toMatch(/bash|sh -c|[;&|<>$`(){}*?[\]'"\\]/);
    }
  });

  it("names install-service's own options, and states the two the working directory does not answer for", () => {
    // install-service composes the unit's ExecStart out of the options it was itself given, so what
    // reaches the machine has to be a CALL and never a unit. --config and --programs are named
    // ABSOLUTELY because the installer does not run in the catalogue: getting it there means a `cd`
    // before the command, and a `cd` followed by a command is a shell composing two out
    // of one line. --runs stays unnamed — its own default is already absolute and already right.
    const argv = installServiceArgv({ executable: `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, listen: "100.64.0.11:9953" });
    expect(argv[0]).toBe(`${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`);
    expect(argv[1]).toBe(INSTALL_SERVICE_PROGRAM);
    expect(argv).toEqual([
      `${BOOTSTRAP_HOME}${ANSIWISE_REST_TOOL}`, INSTALL_SERVICE_PROGRAM,
      "--listen", "100.64.0.11:9953",
      "--service-token-file", SERVICE_TOKEN_FILE,
      "--programs", CATALOG_PROGRAMS,
      "--config", CATALOG_CONFIG,
      "--answers", "-",
    ]);
    expect(CATALOG_PROGRAMS.startsWith(CATALOG_CHECKOUT)).toBe(true);
    expect(argv).not.toContain("--runs");
    // Nothing in it composes a unit. A second spelling of any of these would be a copy of an
    // interface kept by somebody who cannot see it change.
    for (const composed of ["ExecStart", "WantedBy", "Restart=always", "KillMode", "[Service]", "enable"]) {
      expect(argv.join(" "), `the invocation composes "${composed}" itself — that is the binary's to write`).not.toContain(composed);
    }
  });

  it("refuses a machine whose service did not come up, and never reports it ready", async () => {
    // install-service exits zero — it wrote the unit and switched it on — and the service manager
    // then says the machine is not running it, which is what a bind to an address the machine does
    // not hold looks like. The verdict is read off the machine after the call, so the installer's own
    // claim cannot pass for one.
    const hosts = scriptedHosts({ serviceStartsAfterInstall: false });
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    const log: string[] = [];
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc4", log));
    await expect(run).rejects.toThrow(new RegExp(`${ANSIWISE_SERVICE_UNIT} on s1 is inactive after install-service was run`));
    await expect(run).rejects.toThrow(/journalctl -u ansiwise\.service/);
    expect(log.some((l) => l.includes("serves")), "it announced a machine that serves nothing").toBe(false);
  });

  it("gives a machine whose own programs never mint one a token of this manager's, and holds the same value", async () => {
    // The two rows of deploy-platform-services that mint and materialize this value are gated on the
    // books being here, so on a cluster that keeps none the program runs green and the file never
    // comes into being. Until the first slave every machine deployed here kept the books, which is
    // why nothing had ever asked — and a unit enabled without a token comes up failed at every boot
    // with nothing but a journal saying so.
    const hosts = scriptedHosts({ serviceToken: undefined });
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    const log: string[] = [];
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5", log));

    const placed = hosts.serviceToken;
    expect(placed, "the machine carries no token after a run that was supposed to place one").toBeTruthy();
    assertWord(placed ?? "", "the placed token"); // reaches the machine as one plain word or not at all
    expect(hosts.serviceEnabled).toBe(true);

    // THE MANAGER HOLDS THE SAME VALUE. A surface authenticates one token and the manager presents
    // one; a copy that lived only on the machine would be a credential nobody here could ever use.
    const held = (await h.store.list({ serverId: SLAVE_ID, kind: "other" }))
      .filter((c) => c.fingerprint === "ansiwise-service-token");
    expect(held).toHaveLength(1);
    const sealed = await h.store.withOpened(held[0]!.id, { purpose: "test" }, (b) => Promise.resolve(b.toString("utf8")));
    expect(sealed).toBe(placed);

    // AND IT NEVER STOOD IN AN ARGUMENT LIST, where every account on the machine reads it — nor in
    // the run's own record. A run keeps every line a machine writes, and this value is read back off
    // the machine with `sudo cat`: without the read saying its output is a credential, the token
    // stands in the log an operator reads, copies and pastes. It did, once.
    expect(commands(hosts).some((c) => c.includes(placed ?? "no-token")), "the token stood in a command").toBe(false);
    expect(log.some((l) => l.includes(placed ?? "no-token")), "the token stood in the run's log").toBe(false);
  });

  it("gives back what it already holds rather than minting a second value for one machine", async () => {
    // A machine whose file was lost is not a machine that needs a new credential: the surface will
    // authenticate the value this manager presents, and two mints would leave those two disagreeing.
    const hosts = scriptedHosts({ serviceToken: undefined });
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5a1", []));
    const first = hosts.serviceToken;

    hosts.serviceToken = undefined; // the machine loses the file; the manager still holds the value
    await enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5a2", []));
    expect(hosts.serviceToken).toBe(first);
    expect(await h.store.list({ serverId: SLAVE_ID, kind: "other" })).toHaveLength(1);
  });

  it("PLANTED DEFECT: a machine carrying the MASTER part is refused instead, and nothing is written over its own", async () => {
    // There the books cluster's own program wrote the file out of a Vault entry, and the catalogue
    // states that replacing that value means deleting the file AND the entry and running again. A
    // second value written here would leave the manager's copy and that entry disagreeing, so the
    // step refuses exactly as it always did — and says which run mints it.
    const hosts = scriptedHosts({ serviceToken: undefined });
    // `master: false` because the inventory admits exactly one row carrying that part
    // (servers_one_master_uq), and what this case is about is the machine the step is pointed at.
    const h = await makeHarness({ hosts, master: false });
    h.db.db.update(servers).set({ role: "master" }).where(eq(servers.id, SLAVE_ID)).run();
    await placedMachine(hosts);
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5b0", []));
    await expect(run).rejects.toThrow(new RegExp(`answers nothing readable at ${SERVICE_TOKEN_FILE}`));
    await expect(run).rejects.toThrow(/deploy-platform-services/);
    expect(hosts.serviceToken, "it wrote over a value the books cluster's Vault entry stands behind").toBeUndefined();
    expect(hosts.serviceEnabled, "it enabled a unit that cannot read its own credential").toBe(false);
    expect(commands(hosts).some((c) => c.includes(INSTALL_SERVICE_PROGRAM))).toBe(false);
  });

  it("refuses a token file holding something that is not a token", async () => {
    const hosts = scriptedHosts({ serviceToken: "not a token at all" });
    const h = await makeHarness({ hosts });
    await placedMachine(hosts);
    await expect(enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc5b", [])))
      .rejects.toThrow(/does not hold a token/);
    expect(commands(hosts).some((c) => c.includes(INSTALL_SERVICE_PROGRAM))).toBe(false);
  });

  it("refuses a server row with no tailnet address rather than putting the surface anywhere else", async () => {
    // The manager presents the service token in a plain HTTP header, so where the surface stands
    // decides whether that credential crosses a wire somebody else can read. A row without the
    // address means the join or the reading that records it did not happen — and nothing is asked of
    // the machine before that is said.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    h.db.db.update(servers).set({ tailnetHost: null }).where(eq(servers.id, SLAVE_ID)).run();
    await expect(enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6", [])))
      .rejects.toThrow(/carries no tailnet address/);
    // And it says where the value comes from. One step writes this column — declare-tailnet-address,
    // which asks the coordinator — so an empty column here means that reading did not happen, and the
    // refusal has to send the operator there rather than to the join or the membership reading.
    await expect(enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6b", [])))
      .rejects.toThrow(/declare-tailnet-address/);
    expect(commands(hosts), "it reached the machine before finding out where the surface would stand").toHaveLength(0);
  });

  it("refuses a tailnet NAME on the row, naming the column and the shape the binary takes", async () => {
    // servers.tailnetHost is `z.string().min(1)` and its other reader — the cluster map's apiHost —
    // takes a name, so a MagicDNS name is legal on the row and refused by ServiceInstallation, which
    // reads the host as four numbers. The operator is told which of the two shapes he wrote, here,
    // before anything is asked of the machine.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    h.db.db.update(servers).set({ tailnetHost: "s1.tail1234.ts.net" }).where(eq(servers.id, SLAVE_ID)).run();
    const run = enableAnsiwiseServiceStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc6c", []));
    await expect(run).rejects.toThrow(/carries the tailnet address "s1\.tail1234\.ts\.net"/);
    await expect(run).rejects.toThrow(/four numbers/);
    expect(commands(hosts), "it reached the machine with an address it would be refused on").toHaveLength(0);
  });

  it("leaves the unit alone at the head of the list — the bootstrap asks the service manager nothing", async () => {
    // A machine at its first installation has no tailnet address, so place-ansiwise places no
    // service: it neither asks the service manager for a verdict nor writes anything about a unit.
    // The surface is switched on by the step that runs after the join, and by nothing earlier.
    const hosts = scriptedHosts();
    const h = await makeHarness({ hosts });
    await placeAnsiwiseStep(target, ports(h)).run(placeCtx(h, hosts, "run_svc7", []));
    for (const command of commands(hosts)) {
      expect(command).not.toContain("systemctl");
      expect(command).not.toContain(INSTALL_SERVICE_PROGRAM);
    }
    expect(hosts.serviceEnabled).toBe(false);
  });
});
