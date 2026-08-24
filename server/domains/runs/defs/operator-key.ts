import { z } from "zod";
import type { RunDefinition } from "../../../executor/types.ts";
import {
  authorizedKeysReadPlan, authorizedKeysReadSteps, operatorKeyPlan, operatorKeySteps, removeOperatorKeyCleanup,
} from "./operator-key.kit.ts";

// A human operator's own key on the machines, as three run kinds. Each is a run like every other: a
// plan, an approval, steps and a log. The shared scripts, steps and plans live in
// operator-key.kit.ts; what stands here is the one thing that must be written out per run kind, its own
// `kind` literal (the source census in run-definitions-census.test.ts reads exactly that field).
//
// THREE ACTS, AND WHY THE THIRD IS NOT A DETAIL OF THE OTHER TWO.
//
//   operator-key-place    One line appended to one host's ~/.ssh/authorized_keys, carrying the
//                         marker `hostyour-operator:<label>`. Placing the same label again
//                         replaces its line, so a rotated key does not leave its predecessor
//                         working.
//   operator-key-remove   The same filter without the append. It deletes by marker and by nothing
//                         else, so it can never reach the line adopt wrote for this manager —
//                         and it FAILS rather than reporting success when the read-back still finds
//                         the key, which is what happens when somebody placed a copy by hand under
//                         a different comment.
//   authorized-keys-read  Changes nothing and reads the whole file. Without it, a host's reading
//                         would only ever be as fresh as the last time somebody placed or removed a
//                         key on it — and the one thing worth watching for is a key that appeared
//                         when nobody was placing anything.
//
// THIS MANAGER'S OWN KEY IS NEVER A TARGET. It lives in the same file under a different marker
// (`hostyour:<server name>`), it is what every one of these runs travels over, and the acts
// prove it survived by reading the file on both sides of the edit. It is removed by exactly one
// thing in this codebase: the adopt run's own compensation.
//
// All three are `mutating`, so attest-target is pinned as step 0 and cannot be skipped. For the two
// acts that is the usual reason — a run that changes which credentials a machine accepts proves
// first that it is talking to the machine that was adopted. For the read it is a narrower one: the
// run writes a reading onto a server row, and a row may only be told about the machine it names.

export const OperatorKeyParams = z.object({
  serverId: z.string().startsWith("srv_"),
  operatorKeyId: z.string().startsWith("opk_"),
});
export type OperatorKeyParams = z.infer<typeof OperatorKeyParams>;

export const AuthorizedKeysReadParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type AuthorizedKeysReadParams = z.infer<typeof AuthorizedKeysReadParams>;

export const operatorKeyPlaceDef: RunDefinition<OperatorKeyParams> = {
  kind: "operator-key-place",
  paramsSchema: OperatorKeyParams,
  mutating: true,
  plan: async (params, { db }) => operatorKeyPlan("operator-key-place", params, db),
  steps: (params) => operatorKeySteps("operator-key-place", params),
  cleanups: () => [removeOperatorKeyCleanup],
};

export const operatorKeyRemoveDef: RunDefinition<OperatorKeyParams> = {
  kind: "operator-key-remove",
  paramsSchema: OperatorKeyParams,
  mutating: true,
  plan: async (params, { db }) => operatorKeyPlan("operator-key-remove", params, db),
  steps: (params) => operatorKeySteps("operator-key-remove", params),
};

export const authorizedKeysReadDef: RunDefinition<AuthorizedKeysReadParams> = {
  kind: "authorized-keys-read",
  paramsSchema: AuthorizedKeysReadParams,
  mutating: true,
  plan: async (params, { db }) => authorizedKeysReadPlan(params.serverId, db),
  steps: (params) => authorizedKeysReadSteps(params.serverId),
};
