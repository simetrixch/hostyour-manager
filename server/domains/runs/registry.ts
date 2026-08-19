import type { RunKind } from "../../../shared/enums.ts";
import type { Db } from "../../db/client.ts";
import type { AnyRunDefinition, RunDefinition } from "../../executor/types.ts";
import { noopDef } from "./defs/noop.run.ts";
import { adoptDef } from "./defs/adopt.ts";
import { makeDeploySlaveDef, type DeploySlavePorts } from "./defs/deploy-slave.ts";
import type { AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";
import { makeRedeployDef } from "./defs/redeploy.ts";
import { makeReleaseDef } from "./defs/release.ts";
import { makeTailnetDisconnectDef, makeTailnetReconnectDef, makeTailnetRejoinDef } from "./defs/tailnet.ts";
import { passwordLoginDisableDef, passwordLoginEnableDef } from "./defs/password-login.ts";
import { authorizedKeysReadDef, operatorKeyPlaceDef, operatorKeyRemoveDef } from "./defs/operator-key.ts";

export type Registry = Map<RunKind, AnyRunDefinition>;

/** The one sanctioned type-erasure point: a typed RunDefinition<P> is stored as the
 *  executor-facing AnyRunDefinition. The executor parses params via paramsSchema before
 *  calling plan()/steps(), so the erasure is sound at the boundary. */
export function register<P>(registry: Registry, def: RunDefinition<P>): void {
  registry.set(def.kind, def as unknown as AnyRunDefinition);
}

/** The ports the ALWAYS-registered defs take. The platform repo exists only when GITHUB_REPO +
 *  GITHUB_WRITE_PAT are configured — so it stays optional and the step that needs it fails loud when
 *  it is absent, rather than a whole run kind disappearing from the registry. The same holds for
 *  `ansiwiseServeCommand` (ANSIWISE_SERVE_COMMAND): the redeploy master arm's program steps fail
 *  loud without it. `db` is NOT optional: redeploy reads the target's role to decide which of its
 *  two arms it runs, and a definition's steps() is handed the persisted params and no database. */
export interface RegistryPorts extends DeploySlavePorts, AnsiwisePorts {
  db: Db;
}

export function buildRegistry(ports: RegistryPorts, extra: AnyRunDefinition[] = []): Registry {
  const registry: Registry = new Map();
  register(registry, noopDef);
  // The cluster verbs: adopt takes a bare machine into service, deploy-slave turns an adopted
  // server into a live slave, redeploy rebuilds the machine layer of a cluster that is already live,
  // and release raises the platform version that cluster stands on.
  register(registry, adoptDef);
  register(registry, makeDeploySlaveDef(ports));
  register(registry, makeRedeployDef(ports));
  register(registry, makeReleaseDef(ports));
  // The tailnet repair verbs, on a host that is already deployed: leave the private network, come
  // back with the credential the host holds, or be logged out and joined again with one the master
  // mints. Every act is a program of the machine's own catalogue driven over `ansiwise serve`, so
  // they take the serve command, and a rejoin additionally reads the coordinator's address off the
  // platform repo — both fail loud in the step when unconfigured, like redeploy's.
  register(registry, makeTailnetDisconnectDef(ports));
  register(registry, makeTailnetReconnectDef(ports));
  register(registry, makeTailnetRejoinDef(ports));
  // The password-login switch, on a host this controller already holds a key for: shut the sshd
  // password door and destroy the bootstrap password stored beside the server row, or open the
  // door again for a repair. They take no ports — the inventory and the one host are everything.
  register(registry, passwordLoginDisableDef);
  register(registry, passwordLoginEnableDef);
  // A human operator's own key on a host this controller already holds a key for: put one line in
  // ~/.ssh/authorized_keys, take that line back out, or read the whole file and name every key in
  // it. They take no ports — the inventory, the operator-key rows and the one host are everything.
  register(registry, operatorKeyPlaceDef);
  register(registry, operatorKeyRemoveDef);
  register(registry, authorizedKeysReadDef);
  // Opt-in defs constructed with their ports at the composition root (wire.ts) or a test harness:
  // the onboarding family (onboard/offboard/suspend/resume) closes over the Controller's git/kube/
  // vault/gate-runner clients, which only exist when those adapters are configured — so they are
  // injected here rather than statically imported (the executor still needs zero edits).
  for (const def of extra) registry.set(def.kind, def);
  return registry;
}
