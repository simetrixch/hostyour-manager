import { z } from "zod";
import type { RunDefinition } from "../../../executor/types.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./ansiwise-run.kit.ts";
import { passwordLoginPlan, passwordLoginSteps, restorePasswordLoginCleanup } from "./password-login.kit.ts";

// The per-server password-login switch, as two run kinds. Each is a run like every other: a plan, an
// approval, steps and a log. The shared scripts, steps and plan live in password-login.kit.ts; what
// stands here is the one thing that must be written out per run kind, its own `kind` literal (the
// source census in run-definitions-census.test.ts reads exactly that field).
//
// TWO ACTS, AND THEY ARE NOT SYMMETRIC.
//
//   password-login-disable  Two doors shut, not one. The daemon stops taking passwords — proven by
//                           `sshd -T` after the reload, never by the file the run just wrote — and
//                           the bootstrap password sealed beside the server row is destroyed. The
//                           first is a setting a reinstall or a cloud-init rewrite can reopen; the
//                           second is a working credential this manager holds, and it outlives
//                           the machine's configuration.
//   password-login-enable   ONE door, the daemon's. Nothing re-seals a bootstrap password, because
//                           this run has no password to seal — it is a repair run kind, for the case
//                           where a machine has to be reachable without this manager's key.
//
// THE SWITCH DEFAULTS TO OFF, AND DEPLOYING SETS IT. The deployment shuts the door itself, right
// after it has verified key-only login (defs/deploy-slave.ts): there is no state in which password
// login should survive a deployment, so `password-login-enable` is for putting it back deliberately,
// never for turning it on the first time.
//
// BOTH ASK FOR THE MACHINE ACCOUNT'S PASSWORD, under the same name the deployment collects it under
// (ANSIWISE_ELEVATION_SECRET). Reading and writing an sshd configuration are root acts, and a
// machine this platform deployed grants this manager no standing passwordless-root rule — the
// deployment's own `remove-sudoers` takes that file off — so the password a run holds is the route
// every command here takes to root, exactly as it is for the deployment's steps.
//
// Both are `mutating`, so attest-target is pinned as step 0 and cannot be skipped: a run that
// changes which credentials a machine accepts proves first that it is talking to the machine whose
// identity this manager pinned.

export const PasswordLoginParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type PasswordLoginParams = z.infer<typeof PasswordLoginParams>;

export const passwordLoginDisableDef: RunDefinition<PasswordLoginParams> = {
  kind: "cluster-password-login-disable",
  paramsSchema: PasswordLoginParams,
  mutating: true,
  plan: async (params, { db }) => passwordLoginPlan("cluster-password-login-disable", params.serverId, db, ANSIWISE_ELEVATION_SECRET),
  steps: (params) => passwordLoginSteps("cluster-password-login-disable", params.serverId, ANSIWISE_ELEVATION_SECRET),
  cleanups: () => [restorePasswordLoginCleanup(ANSIWISE_ELEVATION_SECRET)],
};

export const passwordLoginEnableDef: RunDefinition<PasswordLoginParams> = {
  kind: "cluster-password-login-enable",
  paramsSchema: PasswordLoginParams,
  mutating: true,
  plan: async (params, { db }) => passwordLoginPlan("cluster-password-login-enable", params.serverId, db, ANSIWISE_ELEVATION_SECRET),
  steps: (params) => passwordLoginSteps("cluster-password-login-enable", params.serverId, ANSIWISE_ELEVATION_SECRET),
};
