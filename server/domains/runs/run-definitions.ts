import type { Db } from "../../db/client.ts";
import type { AnyRunDefinition, RunDefinition } from "../../executor/types.ts";
import { noopDef } from "./defs/noop.run.ts";
import { makeDeploySlaveDef, type DeploySlavePorts } from "./defs/deploy-slave.ts";
import type { AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";
import { makeRedeployDef } from "./defs/redeploy.ts";
import { makeMailDnsPublishDef } from "./defs/mail-dns-publish.ts";
import { makeDnsRemoveDef } from "#unit/server/dns/dns-remove.ts";
import { makeMailDnsUnpublishDef } from "./defs/mail-dns-unpublish.ts";
import type { DnsRecordPorts } from "#unit/server/dns/dns-record.kit.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { MailEgress } from "../../../shared/mail.ts";
import type { Stage } from "../../../shared/enums.ts";
import { makeRemoveSlaveDef } from "./defs/remove-slave.ts";
import { makeRenameSlaveDef, type UnitRecordsRepointer } from "./defs/rename-slave.ts";
import { makeTailnetDisconnectDef, makeTailnetReadDef, makeTailnetReconnectDef, makeTailnetRejoinDef } from "./defs/tailnet.ts";
import { passwordLoginDisableDef, passwordLoginEnableDef } from "./defs/password-login.ts";
import { authorizedKeysReadDef, operatorKeyPlaceDef, operatorKeyRemoveDef } from "./defs/operator-key.ts";

export type RunDefinitions = Map<string, AnyRunDefinition>;

/** The one sanctioned type-erasure point: a typed RunDefinition<P> is stored as the
 *  executor-facing AnyRunDefinition. The executor parses params via paramsSchema before
 *  calling plan()/steps(), so the erasure is sound at the boundary. A kind registered twice is
 *  refused: the second definition would silently replace the first. */
export function register<P>(runDefinitions: RunDefinitions, def: RunDefinition<P>): void {
  if (runDefinitions.has(def.kind)) throw new Error(`run kind ${def.kind} is registered twice`);
  runDefinitions.set(def.kind, def as unknown as AnyRunDefinition);
}

/** The ports the ALWAYS-registered defs take. The platform repo exists only when GITHUB_REPO +
 *  GITHUB_WRITE_PAT are configured — so it stays optional and the step that needs it fails loud when
 *  it is absent, rather than a whole run kind disappearing from the run-definitions map. The same holds for
 *  `ansiwiseServeCommand` (ANSIWISE_SERVE_COMMAND): the redeploy master arm's program steps fail
 *  loud without it. `db` is NOT optional: redeploy reads the target's role to decide which of its
 *  two arms it runs, and a definition's steps() is handed the persisted params and no database. */
export interface RunDefinitionsPorts extends DeploySlavePorts, AnsiwisePorts, DnsRecordPorts {
  db: Db;
  /** The DNS provider mail-dns-publish reads the published records at before and after its program,
   *  and the two removal run kinds delete at. Absent on a manager without a DNS provider: each run
   *  kind then refuses — mail-dns-publish at its program step, the removals at their plan. */
  dns?: DnsProvider;
  /** Where the stage's mail leaves and the key its sender signs with, for mail-dns-publish's answers
   *  — the Mail page's own reading, bound by the composition root. */
  mailEgress?: (stage: Stage, masterDomain: string) => Promise<MailEgress>;
  /** The unit records of a renamed cluster repointed onto its new FQDN — cluster-rename's act on the
   *  zones, bound from the units domain by the composition root. Absent without a DNS provider: the
   *  rename then refuses at the step that needs it. */
  unitRecords?: UnitRecordsRepointer;
}

export function buildRunDefinitions(ports: RunDefinitionsPorts, extra: AnyRunDefinition[] = []): RunDefinitions {
  const runDefinitions: RunDefinitions = new Map();
  register(runDefinitions, noopDef);
  // The cluster run kinds: deploy-slave takes a machine from first contact to a live slave — the key
  // this manager reaches it with is installed by the deployment itself — and redeploy rebuilds the
  // machine layer of a cluster that is already live.
  register(runDefinitions, makeDeploySlaveDef(ports));
  register(runDefinitions, makeRedeployDef(ports));
  // The mail DNS of one sender domain, published by running the catalogue's publish-mail-dns on the
  // master — a master-side act like redeploy's master arm, so it takes the same ports.
  register(runDefinitions, makeMailDnsPublishDef(ports));
  // The two run kinds that take a record BACK out of the zone: one record the DNS inventory names
  // as this installation's, or the three mail records of one sender domain. Registered
  // unconditionally like every other cluster run kind — a manager with no DNS provider and no
  // inventory refuses them at the plan, which is a sentence the operator reads, where an
  // unregistered run kind would answer "unknown run kind" after they had already asked for it.
  register(runDefinitions, makeDnsRemoveDef(ports));
  register(runDefinitions, makeMailDnsUnpublishDef(ports));
  // The inverse of the first: take a slave OUT of the installation. Every act is on the MASTER —
  // the remove-slave program, the books branch, the rows — so it takes the same ports the two
  // above do and reaches the slave not at all.
  register(runDefinitions, makeRemoveSlaveDef(ports));
  register(runDefinitions, makeRenameSlaveDef(ports));
  // The tailnet run kinds, on a host that is already deployed: leave the private network, come
  // back with the credential the host holds, or be logged out and joined again with one the master
  // mints. Every act is a program of the machine's own catalogue driven over `ansiwise-rest serve`, so
  // they take the serve command, and a rejoin additionally reads the coordinator's address off the
  // platform repo — both fail loud in the step when unconfigured, like redeploy's. The READ drives no
  // program and needs neither: it asks the host's client what it is doing and writes the answer down,
  // which is the only way to refresh a reading without performing a repair.
  register(runDefinitions, makeTailnetDisconnectDef(ports));
  register(runDefinitions, makeTailnetReconnectDef(ports));
  register(runDefinitions, makeTailnetRejoinDef(ports));
  register(runDefinitions, makeTailnetReadDef(ports));
  // The password-login switch, on a host this manager already holds a key for: shut the sshd
  // password door and destroy the bootstrap password stored beside the server row, or open the
  // door again for a repair. They take no ports — the inventory and the one host are everything.
  register(runDefinitions, passwordLoginDisableDef);
  register(runDefinitions, passwordLoginEnableDef);
  // A human operator's own key on a host this manager already holds a key for: put one line in
  // ~/.ssh/authorized_keys, take that line back out, or read the whole file and name every key in
  // it. They take no ports — the inventory, the operator-key rows and the one host are everything.
  register(runDefinitions, operatorKeyPlaceDef);
  register(runDefinitions, operatorKeyRemoveDef);
  register(runDefinitions, authorizedKeysReadDef);
  // Opt-in defs constructed with their ports at the composition root (wire.ts) or a test harness:
  // the onboarding family (onboard/offboard/suspend/resume) closes over the Manager's git/kube/
  // vault/gate-runner clients, which only exist when those adapters are configured — so they are
  // injected here rather than statically imported (the executor still needs zero edits).
  for (const def of extra) register(runDefinitions, def);
  return runDefinitions;
}
