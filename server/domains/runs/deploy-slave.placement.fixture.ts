import { DownloadFailed, type ReleaseDownloads } from "../../adapters/downloads/port.ts";
import type { HostsScript } from "./deploy-slave.fixture.ts";
import { PATH_HOME } from "./defs/place-ansiwise.ts";
import { CATALOG_CHECKOUT } from "./defs/machine-state.ts";

// THE SCRIPTED MACHINE'S BOOTSTRAP HALF: what it answers when it is asked which release each of its
// two executables is, what a file transfer does to it, and what the serving binary's install-service
// leaves behind. It reads and writes the SAME HostsScript the rest of the scripted machine does — a
// machine with two states would let a placement leave one of them behind.
//
// EVERY ANSWER COMES OFF WHAT WAS ACTUALLY WRITTEN, never off what the step meant to write. The
// bytes a release address serves SAY which executable and which version they are, the transfer puts
// those bytes on the machine, and `--version` reads them back out — so a bootstrap that fetched the
// wrong asset, wrote it under the wrong name or skipped the write is answered by a machine that says
// so. A fixture that recorded the step's intention instead would agree with every one of those.

/** WHERE the scripted operating account's home is, spelled out. The manager writes a RELATIVE SFTP
 *  path and names the file in a command with `~/` in front of it; the machine resolves both to this,
 *  and install-service writes the RESOLVED path into the unit — so a unit's `ExecStart` and the word
 *  a command was composed with are deliberately two different strings here, which is what makes the
 *  bootstrap's "ask the file the unit names" real rather than a string comparison in disguise. */
export const SCRIPTED_HOME = "/home/ubuntu";

/** The bytes a release serves for one asset. They carry the name and the version because that is the
 *  whole of what the scripted machine can answer afterwards — an executable is a thing that says what
 *  it is when asked, and nothing else about it matters here. */
export function assetBytes(name: string, version: string): Buffer {
  return Buffer.from(`#!ansiwise\n${name} ${version}\n`, "utf8");
}

/** What an executable standing on the machine answers `--version` with: the version its own bytes
 *  carry, or undefined where nothing was ever written under that name. */
export function versionOf(content: string | undefined): string | undefined {
  return content === undefined ? undefined : /^[a-z-]+ (\S+)$/m.exec(content)?.[1];
}

/** The release surface the scripted installation fetches from.
 *
 *  IT ANSWERS THE ADDRESS SHAPE AND REFUSES EVERY OTHER, which is what makes the two placeholders
 *  testable: a bootstrap that filled `<name>` with the wrong word, left a slot standing or fetched
 *  one asset twice asks for an address nothing serves, and this refuses it by name instead of handing
 *  back plausible bytes. `serves` is where a test puts something ELSE at an address — the shape of a
 *  release whose asset is an error page, which only a reading of the machine can catch. */
export class ScriptedReleases implements ReleaseDownloads {
  /** Every address this was asked for, in order. */
  readonly read: string[] = [];

  /** Addresses answered with something other than the asset they name. */
  readonly serves = new Map<string, Buffer>();

  async get(url: string, _opts: { signal: AbortSignal }): Promise<Buffer> {
    this.read.push(url);
    const scripted = this.serves.get(url);
    if (scripted !== undefined) return scripted;
    const named = /^https:\/\/downloads\.example\.invalid\/ansiwise\/([^/]+)\/([a-z-]+)-([^/]+)-linux-x64$/.exec(url);
    const version = named?.[1];
    const name = named?.[2];
    if (version === undefined || name === undefined || named?.[3] !== version) {
      throw new DownloadFailed(url, "nothing is served there");
    }
    return assetBytes(name, version);
  }
}

/** What the file transfer left at `path` on the scripted machine, whole. The manager writes a
 *  relative path, so this is keyed exactly as it was written. */
function fileAt(f: HostsScript, host: string, path: string): string | undefined {
  return f.files.filter((x) => x.host === host && x.path === path).at(-1)?.content;
}

/** The executable a command NAMES, as this machine resolves it: `~/x` and `<home>/x` are one file.
 *  Answered as the relative path the transfer wrote, or undefined for a path this machine keeps
 *  nothing under. */
function executableNamed(word: string): string | undefined {
  for (const prefix of ["~/", `${SCRIPTED_HOME}/`]) {
    if (word.startsWith(prefix)) return word.slice(prefix.length);
  }
  // The path a machine actually LOOKS on. It is kept as a file of its own and not aliased to the
  // home copy: the two are written by two different acts — a transfer and an elevated install — and
  // a fixture that made them one name could never show a machine whose home carries the pin while
  // its path carries something older, which is exactly the state this platform was found in.
  if (word.startsWith(PATH_HOME)) return `${ON_PATH}${word.slice(PATH_HOME.length)}`;
  return undefined;
}

/** How this fixture keeps a file that stands on the machine's path apart from the home copy. */
export const ON_PATH = "path:";

/** The scripted machine's answer to one bootstrap or service command, or undefined where the command
 *  is not one this half of the fixture knows — the exec table then goes on to the rest. */
export function answerPlacementCommand(
  f: HostsScript,
  host: string,
  command: string,
  stdin?: string,
): { out: string; code: number } | undefined {
  const words = command.split(" ");

  // `<executable> --version`, the one reading the bootstrap makes. A file nothing wrote answers
  // nothing and exits 127, exactly as a shell answers a command it cannot find.
  if (words.length === 2 && words[1] === "--version") {
    const named = executableNamed(words[0] ?? "");
    if (named === undefined) return undefined;
    const version = versionOf(fileAt(f, host, named));
    return version === undefined ? { out: "", code: 127 } : { out: version, code: 0 };
  }

  // `sudo -S install -m <mode> <from> <to>` — the elevated copy of a proven executable onto the
  // machine's path. Answered by actually copying, so the reading that follows reads what was put
  // there rather than what the step meant to put there.
  if (words[0] === "sudo" && words[1] === "-S" && words[2] === "install" && words.length === 7) {
    const from = executableNamed(words[5] ?? "");
    const to = executableNamed(words[6] ?? "");
    if (from === undefined || to === undefined) return undefined;
    const content = fileAt(f, host, from);
    if (content === undefined) return { out: `install: cannot stat '${words[5]}'`, code: 1 };
    f.files.push({ host, path: to, content, mode: Number.parseInt(words[4] ?? "755", 8) });
    return { out: "", code: 0 };
  }

  const catalogue = answerCatalogueCommand(f, words);
  if (catalogue !== undefined) return catalogue;

  if (command === "systemctl is-enabled ansiwise.service") {
    return { out: f.serviceEnabled ? "enabled" : "disabled", code: f.serviceEnabled ? 0 : 1 };
  }
  if (command === "systemctl is-active ansiwise.service") {
    return { out: f.serviceActive ? "active" : "inactive", code: f.serviceActive ? 0 : 3 };
  }
  if (command === "systemctl show -p ExecStart ansiwise.service") {
    return { out: execStartLine(f), code: 0 };
  }

  // The token, read with the run's own elevation. A machine that has not been through the program
  // that mints it answers nothing and fails — which is the refusal the caller names by name.
  if (command === "sudo -S cat /etc/ansiwise/service-token") {
    return f.serviceToken === undefined
      ? { out: "", code: 1 }
      : { out: f.serviceToken, code: 0 };
  }

  // The manager writing a token onto a machine whose own programs never mint one. What lands in the
  // file is what stood on standard input AFTER the line sudo took for the password — the machine
  // splits it exactly where sudo splits it, so a caller that put the value anywhere else writes
  // nothing here. Remembered, so the `cat` above reads back what was actually written.
  if (command === "sudo -S install -D -m 600 -o root -g root /dev/stdin /etc/ansiwise/service-token") {
    const payload = (stdin ?? "").split("\n").slice(1).join("\n");
    if (payload.length === 0) return { out: "install: reading /dev/stdin: no bytes", code: 1 };
    f.serviceToken = payload;
    return { out: "", code: 0 };
  }

  if (command === "sudo -S systemctl restart ansiwise.service") {
    f.serviceRunningVersion = f.serviceActive ? f.serviceExecVersion : undefined;
    return { out: "", code: 0 };
  }

  if (words[1] === "install-service") {
    return installService(f, host, words);
  }
  return undefined;
}

/** The catalogue checkout, answered the way a machine holds one rather than by a marker: `test -d`
 *  decides whether there is one at all, `symbolic-ref` names the branch it stands on, `rev-parse`
 *  reads the head it is ACTUALLY on, and `reset --hard` MOVES that head to what origin carries. So a
 *  caller that fetched and never stood the tree on what it fetched is answered by a machine whose
 *  head did not move, and a caller that skipped the fetch is answered by the exit code the fetch was
 *  scripted with.
 *
 *  Undefined for every command that is not about the catalogue, so the table above goes on. */
function answerCatalogueCommand(f: HostsScript, words: string[]): { out: string; code: number } | undefined {
  // THE CREDENTIAL RIDES IN FRONT OF THE COMMAND, so the command is read past it. `env NAME=value`
  // is how one git call is given this manager's askpass without the token becoming an argument, and
  // a table that matched on the first word alone would see `env` and answer nothing about git.
  const bare = words[0] === "env" ? words.slice(1).filter((w) => !w.includes("=")) : words;
  const [head, ...rest] = bare;
  // A CLONE MAKES THE MACHINE ONE. What the caller does next is what it does to a machine that
  // carries a catalogue, so the script starts carrying one from here.
  if (head === "git" && rest[0] === "clone" && rest.at(-1) === CATALOG_CHECKOUT) {
    if (f.catalogueBranch !== undefined) return { out: `fatal: destination path '${CATALOG_CHECKOUT}' already exists`, code: 128 };
    if (f.catalogueCloneExit !== 0) return { out: "fatal: could not read Username", code: f.catalogueCloneExit };
    f.catalogueBranch = f.catalogueClonesOnto;
    f.catalogueHead = f.catalogueRemoteHead;
    return { out: "", code: 0 };
  }
  if (head === "test" && rest[0] === "-d" && rest[1] === `${CATALOG_CHECKOUT}/.git`) {
    return { out: "", code: f.catalogueBranch === undefined ? 1 : 0 };
  }
  if (head !== "git" || rest[0] !== "-C" || rest[1] !== CATALOG_CHECKOUT) return undefined;
  const argv = rest.slice(2);
  // A machine with no catalogue answers every one of these the way git does in a directory that is
  // not a repository: it refuses, with the exit code it uses for a fatal.
  if (f.catalogueBranch === undefined) return { out: "fatal: not a git repository", code: 128 };
  if (argv[0] === "symbolic-ref") return { out: f.catalogueBranch, code: 0 };
  if (argv[0] === "rev-parse") return { out: f.catalogueHead, code: 0 };
  if (argv[0] === "fetch") {
    return argv[1] === "origin" && argv[2] === f.catalogueBranch
      ? { out: "", code: f.catalogueFetchExit }
      : { out: `fatal: couldn't find remote ref ${argv[2] ?? ""}`, code: 128 };
  }
  if (argv[0] === "reset" && argv[1] === "--hard") {
    if (argv[2] !== `origin/${f.catalogueBranch}`) return { out: `fatal: ambiguous argument '${argv[2] ?? ""}'`, code: 128 };
    f.catalogueHead = f.catalogueRemoteHead;
    return { out: `HEAD is now at ${f.catalogueHead}`, code: 0 };
  }
  return undefined;
}

/** What `systemctl show -p ExecStart ansiwise.service` writes on the scripted machine. The whole
 *  line, not the two fields the manager reads out of it: a reading that took a shortcut through this
 *  would be answered in its own words instead of the service manager's. */
function execStartLine(f: HostsScript): string {
  if (f.serviceExecPath === undefined) return "ExecStart=";
  const listen = f.serviceExecListen === undefined ? "" : `--listen ${f.serviceExecListen} `;
  return `ExecStart={ path=${f.serviceExecPath} ; argv[]=${f.serviceExecPath} service ${listen}` +
    "--service-token-file /etc/ansiwise/service-token --programs /srv/ansiwise-catalog/ansiwise/programs " +
    "--config /srv/ansiwise-catalog/ansiwise.yaml ; ignore_errors=no ; pid=0 }";
}

/** The serving binary placing its own unit, modelled on what the real one does: it refuses a caller
 *  that is not the serving binary, refuses an invocation with no token in the envelope, writes a unit
 *  whose `ExecStart` names THE FILE IT WAS RUN AS resolved to an absolute path, and ends at
 *  `systemctl enable --now` — which starts a unit that is not running and does NOTHING to one that
 *  is. That last one is why the caller restarts, and why this fixture keeps the running version apart
 *  from the unit's. */
function installService(f: HostsScript, host: string, words: string[]): { out: string; code: number } {
  const named = executableNamed(words[0] ?? "");
  if (named !== "ansiwise-rest") {
    return {
      out: `ansiwise has no program called "install-service"`,
      code: 64,
    };
  }
  const version = versionOf(fileAt(f, host, named));
  if (version === undefined) return { out: "", code: 127 };
  const wasActive = f.serviceActive;
  f.serviceExecPath = `${SCRIPTED_HOME}/${named}`;
  f.serviceExecVersion = version;
  f.serviceExecListen = words[words.indexOf("--listen") + 1];
  f.serviceEnabled = true;
  f.serviceActive = f.serviceStartsAfterInstall;
  if (!wasActive) f.serviceRunningVersion = f.serviceActive ? version : undefined;
  return { out: `${f.serviceExecPath} is written and ansiwise.service comes back after a restart`, code: 0 };
}
