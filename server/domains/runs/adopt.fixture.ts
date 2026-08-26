// The fake Ubuntu server the adopt run kind is driven against, and the workbench that wires one run
// of it. Shared by adopt.test.ts and adopt.sudo.test.ts, which drive the same run for two different
// questions: what the adoption leaves on the ROW, and what it leaves on the MACHINE.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { SUDOERS_DROP_IN } from "./defs/adopt.ts";
import { servers } from "../../db/schema/inventory.ts";
import { ExecFailedError } from "../../adapters/ssh/port.ts";
import type { SshFactory, SshSession, SshTarget, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    MANAGER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

export const PASSWORD = "sesame-open-1234";
export const HEALTHY_PREFLIGHT = [
  "CHECK os.ubuntu PASS ubuntu 26.04",
  "CHECK os.arch PASS x86_64",
  "CHECK cpu.count PASS 8 cores",
  "CHECK mem.total PASS 32 GiB",
  "CHECK disk.free PASS 900 GB free",
  "CHECK port.22 PASS sshd listening",
  "CHECK net.egress PASS github.com reachable",
  "PUBLIC_IP 203.0.113.7",
].join("\n");

// What the tailnet probe prints on a machine the platform has never touched: no client, because
// the client arrives with the base install that deploy-slave runs. This is the normal adopt-time
// reading, and the one line is what tells "measured, none there" from "nothing was measured".
export const PROBE_NO_CLIENT = "TAILNET client absent";

// What `sshd -T` prints on a freshly installed cloud image: a daemon that takes a password from
// anyone who can reach it. Every adopt in this file starts from that, because every real one does.
const SSHD_TAKES_PASSWORD = ["SSHD effective readable", "SSHD password yes", "SSHD keyboard yes", "SSHD pubkey yes"].join("\n");
const SSHD_KEY_ONLY = ["SSHD effective readable", "SSHD password no", "SSHD keyboard no", "SSHD pubkey yes"].join("\n");

// The key whoever ordered the machine put in the image — the normal state of a fresh cloud server,
// and a working way in that no run kind on this platform can remove. The fake host's authorized_keys
// holds this plus whatever line install-key really appends (captured off the shipped command), so
// the probe reads back the key the run actually sealed — classification then rests on the sealed
// fingerprint, exactly as on a real host.
const IMAGE_KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICloudImageKeyAAAAAAAAAAAAAAAAAAAAAAA someone@example.com";

/** The blanket line, as sudo would read it out of a drop-in: every command, as every user, without
 *  a password. The fake host uses it for the same purpose the real `sudo -l` pipeline does. */
export const BLANKET_LINE = /^[^#]*ALL[ \t]*=[ \t]*\(ALL(?:[ \t]*:[ \t]*ALL)?\)[ \t]*NOPASSWD:[ \t]*ALL[ \t]*$/m;

/** What an EARLIER adoption left on every machine it touched, and the state this suite plants to
 *  prove the run takes it back. */
export const LEGACY_BLANKET_DROP_IN = "digi1 ALL=(ALL) NOPASSWD:ALL\n";

/** What the MACHINE'S OWN sudoers grants this account — the entry no run here writes and none can
 *  take back, and therefore the only right that survives whatever configure-sudo installs.
 *
 *    "none"      no entry of the account's own. It reaches root ONLY through
 *                /etc/sudoers.d/90-hostyour, and only for the commands that file names. A machine an
 *                earlier adoption left carrying the blanket line in that file is this case: the
 *                blanket is its whole way to root, and the install is the moment that way is
 *                replaced by the new file.
 *    "password"  `ALL=(ALL) ALL` — every command as root once the account's password is given. The
 *                ordinary cloud-image account, and the state a first adoption arrives on.
 *    "nopasswd"  `ALL=(ALL) NOPASSWD:ALL` from the machine's own configuration. configure-sudo
 *                writes nothing on this machine: there is nothing a second grant would add and
 *                nothing this product could take back. */
type MachineSudo = "none" | "password" | "nopasswd";

function escapeForPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A sudoers matcher faithful enough to answer the only question that matters here: MAY this
 *  account run this command as root without a password? sudo resolves the command through
 *  `secure_path` and compares the resolved path, then matches the CONCATENATED argument string
 *  against the rule's, where `*` stands for any run of characters and `""` means "takes none". A
 *  rule that names no arguments at all permits any.
 *
 *  IT MODELS `*` AND NOTHING ELSE. sudo compares with fnmatch(3), so `[`, `?` and `\` are
 *  metacharacters there as well and a rule carrying one would be read differently on a machine than
 *  it is here. adopt.sudo.test.ts fails any MANAGER_ELEVATED row that carries one, which is what
 *  keeps this matcher's answer and the machine's the same answer. */
export function sudoersPermits(file: string | null, command: string): boolean {
  if (file === null) return false;
  const flat = file.replace(/\\\n\s*/g, " ");
  const list = /NOPASSWD:\s*([\s\S]*)$/.exec(flat)?.[1];
  if (!list) return false;
  const argv = command.replace(/\s*\d?>\s*\/dev\/null/g, "").trim().split(/\s+/);
  const name = argv[0] ?? "";
  const args = argv.slice(1).join(" ");
  return list.split(",").map((r) => r.trim()).filter(Boolean).some((rule) => {
    const parts = rule.split(/\s+/);
    const path = parts[0] ?? "";
    if (path !== name && path.slice(path.lastIndexOf("/") + 1) !== name) return false;
    const pattern = parts.slice(1).join(" ");
    if (pattern === "") return true;
    if (pattern === '""') return args === "";
    return new RegExp(`^${pattern.split("*").map(escapeForPattern).join("[\\s\\S]*")}$`).test(args);
  });
}

// A scripted fake Ubuntu server: password auth accepts only PASSWORD, key auth always
// accepts, and each adopt command returns a canned success. `preflightOut` lets a test
// inject hard-failing checks; `probeOut` lets one inject a host that is on the tailnet.
// `sshdOut` answers the password-login probe, which the adopt run runs twice — once before it
// shuts the daemon's password door and once after — so it is a function of the call count.
//
// THE SUDO SIDE IS MODELLED AS THE RIGHT, NOT AS THE FILE. `host.machineSudo` is what the machine's
// OWN sudoers grants the account, which no run here writes and none can take back, and
// `host.dropIn` is the live content of /etc/sudoers.d/90-hostyour, which the run's own `install`
// really replaces. Every `sudo` the run ships is then answered by asking whether those two together
// permit it, so a test asserting that a command reached root is asserting the machine's answer and
// not the manager's intention. `host.commands` collects every command line the run really shipped.
export interface FakeHost {
  /** What the machine's OWN sudoers grants this account. Defaults to `"none"`. */
  machineSudo?: MachineSudo;
  /** The live content of /etc/sudoers.d/90-hostyour, which the run's own `install` really replaces.
   *  `null` is the file not being there. */
  dropIn?: string | null;
  /** A machine on which the rewrite does not take: whatever the run installs, the file comes back
   *  granting every command. Nothing on a real host is expected to behave this way — it is the
   *  state the run's own proof exists to catch. */
  installLeavesBlanket?: boolean;
  commands?: string[];
}

export function fakeFactory(preflightOut = HEALTHY_PREFLIGHT, probeOut = PROBE_NO_CLIENT,
  sshdOut: (call: number) => string = (call) => (call === 0 ? SSHD_TAKES_PASSWORD : SSHD_KEY_ONLY),
  host: FakeHost = {}): SshFactory {
  let sshdCall = 0;
  const installed: string[] = []; // the authorized_keys lines install-key really appended
  let pending: string | null = null; // what `cat > /tmp/dc-sudoers-…` holds, before `install` moves it
  if (host.dropIn === undefined) host.dropIn = null;
  const machineSudo: MachineSudo = host.machineSudo ?? "none";
  const dropInBlanket = (): boolean => host.dropIn !== null && host.dropIn !== undefined && BLANKET_LINE.test(host.dropIn);
  const blanketNow = (): boolean => machineSudo === "nopasswd" || dropInBlanket();
  return (target: SshTarget) => {
    if (target.auth.kind === "password" && target.auth.password.toString("utf8") !== PASSWORD) {
      return Promise.reject(new Error("authentication failed"));
    }
    // Root needs no rule to reach root, which is why configure-sudo writes nothing for it and why
    // `sudo -n` still answers on a machine adopted that way.
    const permits = (command: string): boolean =>
      target.username === "root" || blanketNow() || sudoersPermits(host.dropIn ?? null, command);
    // …and the same question with the account's password on stdin. THE PASSWORD AUTHENTICATES, IT
    // DOES NOT AUTHORIZE: proving who the account is buys nothing where no rule names the command,
    // so `sudo -S` reaches past `permits()` only as far as the machine's own sudoers entry goes. An
    // account whose entry is "none" therefore loses every command /etc/sudoers.d/90-hostyour does
    // not name the instant the run replaces that file — which is the machine an earlier adoption
    // left blanket, and the one this run exists to repair.
    const permitsWithPassword = (command: string): boolean => machineSudo !== "none" || permits(command);
    const execImpl = async (command: string, o: ExecOptions): Promise<ExecResult> => {
      const emit = (s: string): void => {
        for (const l of s.split("\n")) o.onStdout?.(l);
      };
      host.commands?.push(command);
      if (command.startsWith("sudo -S ")) {
        // A `sudo -S` that arrives without the password would prompt on a real machine and fail.
        // Answering it anyway would let a call site lose its password with every assertion green.
        if (o.stdin?.toString("utf8") !== `${PASSWORD}\n`) {
          throw new Error(`sudo -S shipped without the password on stdin: ${command}`);
        }
        const asked = command.slice("sudo -S ".length).replace(/^(?:-p '' |-- )+/, "");
        if (!permitsWithPassword(asked)) {
          return { code: 1, stdoutTail: "", stderrTail: `sudo: ${target.username} is not allowed to execute '${asked}' as root` };
        }
      }
      // `sudo -l | grep -q` is the question about the RIGHT: grep's exit code is the answer, so a
      // machine that does not grant it answers 1 here, exactly as the real pipeline would.
      if (command.startsWith("LC_ALL=C sudo -n -l")) {
        return { code: blanketNow() ? 0 : 1, stdoutTail: "", stderrTail: "" };
      }
      // …and the second question, about the FILE this product writes: whether the answer above is
      // this product's own doing. Only the `cat` is elevated, and it is asked of the drop-in the
      // same way any other elevated command is — a machine that does not permit it feeds the grep
      // nothing, and an empty pipeline answers 1, which is the answer "not granted".
      if (command.startsWith(`sudo -n cat ${SUDOERS_DROP_IN}`)) {
        const readable = permits(`cat ${SUDOERS_DROP_IN}`);
        return { code: readable && dropInBlanket() ? 0 : 1, stdoutTail: "", stderrTail: "" };
      }
      if (command.startsWith("cat > /tmp/dc-sudoers-")) {
        pending = o.stdin?.toString("utf8") ?? "";
        return { code: 0, stdoutTail: "", stderrTail: "" };
      }
      if (command.includes("install -m 0440 -o root -g root") && command.includes(SUDOERS_DROP_IN)) {
        host.dropIn = host.installLeavesBlanket === true ? LEGACY_BLANKET_DROP_IN : pending;
        return { code: 0, stdoutTail: "", stderrTail: "" };
      }
      if (command.startsWith("sudo -n ")) {
        const asked = command.slice("sudo -n ".length);
        if (!permits(asked)) return { code: 1, stdoutTail: "", stderrTail: `sudo: a password is required` };
        if (asked.startsWith("rm -f ") && asked.includes(SUDOERS_DROP_IN)) host.dropIn = null;
        return { code: 0, stdoutTail: "", stderrTail: "" };
      }
      if (command === "whoami") emit(target.username);
      else if (command.includes("dc-preflight-")) emit(preflightOut);
      else if (command.includes("dc-baseline-")) emit("BASE nproc 8\nBASE public_ip 203.0.113.7");
      else if (command.includes("dc-tailnet-probe-")) emit(probeOut);
      else if (command.includes("dc-password-login-probe-")) emit(sshdOut(sshdCall++));
      else if (command.includes(">> ~/.ssh/authorized_keys")) {
        const line = /echo '([^']+)' >> ~\/\.ssh\/authorized_keys/.exec(command)?.[1];
        if (line) installed.push(line);
      } else if (command.includes("dc-authorized-keys-probe-")) {
        emit(["AKEYS readable", ...installed.map((l) => `AKEY ${l}`), `AKEY ${IMAGE_KEY_LINE}`].join("\n"));
      }
      return { code: 0, stdoutTail: "", stderrTail: "" };
    };
    const session: SshSession = {
      hostKeyFingerprint: () => "SHA256:fixture",
      isClosed: () => false, // a fake transport never dies under a step
      close: () => undefined,
      putFile: async () => undefined,
      forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
      openChannel: () => Promise.reject(new Error("no conversation in the adopt fixture")),
      exec: execImpl,
      mustExec: async (command, o) => {
        const r = await execImpl(command, o);
        if (r.code !== 0) throw new ExecFailedError(r.code, r.stderrTail, command);
        return r;
      },
    };
    return Promise.resolve(session);
  };
}

/** One test's worth of manager: a fresh database, a credential store, an executor wired to the fake
 *  host, and the bare server row the adoption starts from. `dispose` is what the suite's afterEach
 *  calls. */
export function adoptWorkbench(): {
  make: (factory?: SshFactory, sshUser?: string) => { db: DbHandle; executor: Executor; store: CredentialStore; serverId: string };
  dispose: () => void;
} {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  return {
    make(factory: SshFactory = fakeFactory(), sshUser = "root") {
      const dir = mkdtempSync(join(tmpdir(), "mgr-adopt-"));
      dirs.push(dir);
      const db = openDb(join(dir, "c.db"));
      handles.push(db);
      const store = new CredentialStore({ db: db.db, logger });
      const executor = new Executor({
        db: db.db, creds: store, bus: new RunEventBus(), logger,
        runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: factory, actor: () => "op_system",
      });
      const serverId = "srv_adopt1";
      db.db.insert(servers).values({ id: serverId, name: "s5", host: "203.0.113.7", sshPort: 22, sshUser }).run();
      return { db, executor, store, serverId };
    },
    dispose() {
      for (const h of handles.splice(0)) h.sqlite.close();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
