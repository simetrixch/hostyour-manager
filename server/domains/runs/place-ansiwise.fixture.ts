import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import {
  hostsFactory, logger, SLAVE_ID, PARAMS, ANSIWISE_DOWNLOAD_URL, ANSIWISE_CATALOG_URL,
  type HostsScript, type Harness,
} from "./deploy-slave.fixture.ts";
import { statedTarget, type DeploySlavePorts } from "./defs/deploy-slave.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";

// What the two placement suites share: the values a placement is stated with, the ports record the
// manager's half reads them out of, and one step run against the scripted slave. Both suites drive
// the SAME mechanism (place-ansiwise.ts) through the SAME two steps (deploy-slave.ts), so a second
// copy of this would be two scripted machines that could disagree about what a placed one looks
// like — place-ansiwise.test.ts is about the three placements, place-ansiwise.service.test.ts about
// the fourth.

export const ELEVATION = "elevation-password-SECRET-0007";
export const CATALOG_TOKEN = "catalog-read-token-SECRET-0008";
export const PORTS_URL = "https://github.com/acme/hostyour-cloud.git";

/** The ports the step takes, with one of them left out where a test is about an installation that
 *  did not configure it, or the catalogue credential added where it is about a private catalogue. */
export function ports(h: Harness, variant?: "download-url" | "repo-url" | "catalog-url" | "with-token"): DeploySlavePorts & AnsiwisePorts {
  return {
    platformRepo: h.platformRepo,
    ...(variant === "repo-url" ? {} : { platformRepoUrl: PORTS_URL }),
    ...(variant === "download-url" ? {} : { ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL }),
    ...(variant === "catalog-url" ? {} : { ansiwiseCatalogUrl: ANSIWISE_CATALOG_URL }),
    ...(variant === "with-token" ? { ansiwiseCatalogToken: CATALOG_TOKEN } : {}),
  };
}

/** One step run against the scripted slave. `runId` is what makes the uploaded script's path unique,
 *  exactly as a second run of the real step has a second run id. */
export function placeCtx(h: Harness, hosts: HostsScript, runId: string, log: string[]): StepCtx {
  const factory = hostsFactory(hosts);
  const session = (): Promise<SshSession> => factory({
    host: "10.1.1.11", port: 22, username: "ubuntu",
    auth: { kind: "key", privateKey: Buffer.from("k") },
  });
  let checkpoint: unknown;
  return {
    runId,
    stepName: "place-ansiwise",
    db: h.db.db,
    creds: h.store,
    params: { serverId: SLAVE_ID },
    secrets: {
      get: (name) => (name === ANSIWISE_ELEVATION_SECRET ? Buffer.from(ELEVATION, "utf8") : undefined),
      wipe: () => undefined,
    },
    signal: new AbortController().signal,
    logger,
    ssh: session,
    openPasswordSession: () => Promise.reject(new Error("not in this test")),
    closePasswordSession: () => undefined,
    attest: () => Promise.resolve(),
    log: (_stream, text) => log.push(text),
    checkpoint: (data) => (checkpoint = data),
    readCheckpoint: <T,>() => checkpoint as T | undefined,
    registerCleanup: () => undefined,
  };
}

export const target = statedTarget(SLAVE_ID, PARAMS.domain, "prod");

/** The placing scripts this run of the step put on the machine — none means it placed nothing. */
export function placingScripts(hosts: HostsScript): string[] {
  return hosts.files.filter((f) => f.path.includes("dc-place-ansiwise-")).map((f) => f.content);
}
