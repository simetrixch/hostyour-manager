import { z } from "zod";
import type { RunDefinition } from "../../../executor/types.ts";
import { passwordLoginPlan, passwordLoginSteps, restorePasswordLoginCleanup } from "./password-login.kit.ts";

// The per-server password-login switch, as two verbs. Each is a run like every other: a plan, an
// approval, steps and a log. The shared scripts, steps and plan live in password-login.kit.ts; what
// stands here is the one thing that must be written out per verb, its own `kind` literal (the
// source census in registry-census.test.ts reads exactly that field).
//
// TWO ACTS, AND THEY ARE NOT SYMMETRIC.
//
//   password-login-disable  Two doors shut, not one. The daemon stops taking passwords — proven by
//                           `sshd -T` after the reload, never by the file the run just wrote — and
//                           the bootstrap password sealed beside the server row is destroyed. The
//                           first is a setting a reinstall or a cloud-init rewrite can reopen; the
//                           second is a working credential this controller holds, and it outlives
//                           the machine's configuration.
//   password-login-enable   ONE door, the daemon's. Nothing re-seals a bootstrap password, because
//                           this run has no password to seal — it is a repair verb, for the case
//                           where a machine has to be reachable without this controller's key.
//
// THE SWITCH DEFAULTS TO OFF, AND ADOPTION SETS IT. The adopt run shuts the door itself, right
// after it has verified key-only login (defs/adopt.ts): there is no state in which password login
// should survive an adoption, so `password-login-enable` is for putting it back deliberately, never
// for turning it on the first time.
//
// Both are `mutating`, so attest-target is pinned as step 0 and cannot be skipped: a run that
// changes which credentials a machine accepts proves first that it is talking to the machine that
// was adopted.

export const PasswordLoginParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type PasswordLoginParams = z.infer<typeof PasswordLoginParams>;

export const passwordLoginDisableDef: RunDefinition<PasswordLoginParams> = {
  kind: "password-login-disable",
  paramsSchema: PasswordLoginParams,
  mutating: true,
  plan: async (params, { db }) => passwordLoginPlan("password-login-disable", params.serverId, db),
  steps: (params) => passwordLoginSteps("password-login-disable", params.serverId),
  cleanups: () => [restorePasswordLoginCleanup],
};

export const passwordLoginEnableDef: RunDefinition<PasswordLoginParams> = {
  kind: "password-login-enable",
  paramsSchema: PasswordLoginParams,
  mutating: true,
  plan: async (params, { db }) => passwordLoginPlan("password-login-enable", params.serverId, db),
  steps: (params) => passwordLoginSteps("password-login-enable", params.serverId),
};
