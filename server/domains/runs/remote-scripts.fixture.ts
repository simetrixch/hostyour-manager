// EVERY SHELL SCRIPT THIS MANAGER UPLOADS TO A MACHINE, RENDERED, so a real parser can read them
// before a customer's machine does.
//
// Each one is a TypeScript template literal. The compiler checks the INTERPOLATION and nothing checks
// the shell: a missing `fi`, an unbalanced brace, a quote closed one character early — all of them
// type-check, and the first program that ever reads them as shell is `bash` on somebody's host. What
// the operator then sees is a run that failed on the machine with an exit code, so they go and look
// at the machine, which is the one place the answer is not.
//
// WHAT IS A LIST HERE AND WHAT IS NOT. The ARGUMENTS below are a list, because nothing can derive a
// domain, an FQDN or a key label — a script that takes one has to be rendered with something. The SET
// of scripts is NOT a list: remote-syntax.test.ts walks every `remoteScript`/`remoteScriptCapture`
// call in this repository with the TypeScript compiler, reads which symbol each one uploads, and
// fails if that set and the keys below differ. So a script added to a run and left out of here is a
// red test, not a quietly narrower check.
//
// The values are placeholders on purpose (CLAUDE.md): `example.invalid` is the placeholder, and no
// installation's real domain belongs in this tree.
import { PREFLIGHT_SCRIPT } from "./preflight.ts";
import { AUTHORIZED_KEYS_PROBE_SCRIPT } from "./operator-keys-probe.ts";
import { PASSWORD_LOGIN_PROBE_SCRIPT } from "./password-login-probe.ts";
import { TAILNET_PROBE_SCRIPT } from "./tailnet-probe.ts";
import { DISABLE_SCRIPT, ENABLE_SCRIPT } from "./defs/password-login.kit.ts";
import { placeScript, removeScript } from "./defs/operator-key.kit.ts";
import { removeSudoersScript, SUDOERS_DROP_IN } from "./defs/manager-key.kit.ts";
import {
  CERTS_CMD,
  SECRET_STORES_CMD,
  argoAppsCmd,
  dnsProbeScript,
  externalSecretsCmd,
  forceSyncExternalSecretsCmd,
  slaveDiagScript,
} from "./defs/deploy-slave.remote.ts";

/** A slave FQDN, in the placeholder domain. */
const SLAVE_FQDN = "s1.example.invalid";

/** An ed25519 public key of the right SHAPE and no value — the operator-key scripts embed whatever
 *  they are given into a printf, so what matters here is that it carries the spaces, the base64 and
 *  the comment a real key has. */
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp operator@example.invalid";

/** One script as it leaves this repository, keyed by the exported symbol the run uploads. The key is
 *  what the census compares against, so it is the SYMBOL and never a description of it. */
export interface RemoteScript {
  /** The exported const or function the run passes to remoteScript/remoteScriptCapture. */
  symbol: string;
  /** Where a reader finds it. */
  module: string;
  /** The text `bash` would read on the host. */
  text: string;
}

export const REMOTE_SCRIPTS: readonly RemoteScript[] = [
  { symbol: "PREFLIGHT_SCRIPT", module: "server/domains/runs/preflight.ts", text: PREFLIGHT_SCRIPT },
  { symbol: "AUTHORIZED_KEYS_PROBE_SCRIPT", module: "server/domains/runs/operator-keys-probe.ts", text: AUTHORIZED_KEYS_PROBE_SCRIPT },
  { symbol: "PASSWORD_LOGIN_PROBE_SCRIPT", module: "server/domains/runs/password-login-probe.ts", text: PASSWORD_LOGIN_PROBE_SCRIPT },
  { symbol: "TAILNET_PROBE_SCRIPT", module: "server/domains/runs/tailnet-probe.ts", text: TAILNET_PROBE_SCRIPT },
  { symbol: "ENABLE_SCRIPT", module: "server/domains/runs/defs/password-login.kit.ts", text: ENABLE_SCRIPT },
  { symbol: "DISABLE_SCRIPT", module: "server/domains/runs/defs/password-login.kit.ts", text: DISABLE_SCRIPT },
  { symbol: "removeSudoersScript", module: "server/domains/runs/defs/manager-key.kit.ts", text: removeSudoersScript(SUDOERS_DROP_IN) },
  { symbol: "placeScript", module: "server/domains/runs/defs/operator-key.kit.ts", text: placeScript(PUBLIC_KEY, "operator-1") },
  { symbol: "removeScript", module: "server/domains/runs/defs/operator-key.kit.ts", text: removeScript("operator-1") },
  { symbol: "dnsProbeScript", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: dnsProbeScript(SLAVE_FQDN) },
  { symbol: "slaveDiagScript", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: slaveDiagScript(SLAVE_FQDN) },
];

/** The command LINES a run composes and sends over the session (remoteCmd / remoteExec /
 *  execCapture) rather than uploading as a file. A quote closed one character early breaks them the
 *  same way and costs the same run, so they are parsed here too — the same collection rule applies:
 *  the census fails when a call sends a symbol this list does not carry.
 *
 *  A command written INLINE at its call site is not here, and does not have to be: the census holds
 *  every inline one to a single line, and a one-line command is one the reader of the call site sees
 *  whole. The moment one grows a second line it has to become a symbol, because that is where a
 *  missing `fi` can hide. */
export const REMOTE_COMMANDS: readonly RemoteScript[] = [
  { symbol: "SECRET_STORES_CMD", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: SECRET_STORES_CMD },
  { symbol: "CERTS_CMD", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: CERTS_CMD },
  { symbol: "argoAppsCmd", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: argoAppsCmd(SLAVE_FQDN) },
  { symbol: "externalSecretsCmd", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: externalSecretsCmd(SLAVE_FQDN) },
  { symbol: "forceSyncExternalSecretsCmd", module: "server/domains/runs/defs/deploy-slave.remote.ts", text: forceSyncExternalSecretsCmd(SLAVE_FQDN) },
];
