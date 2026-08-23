import type { StepCtx } from "../../executor/types.ts";
import type { SshSession } from "../../adapters/ssh/port.ts";
import {
  hostsFactory, logger, SLAVE_ID, PARAMS, ANSIWISE_DOWNLOAD_URL,
  type HostsScript, type Harness,
} from "./deploy-slave.fixture.ts";
import { statedTarget, type DeploySlavePorts } from "./defs/deploy-slave.kit.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./defs/ansiwise-run.kit.ts";

// What the two bootstrap suites share: the values a placement is stated with, the ports record the
// manager's half reads them out of, and one step run against the scripted slave. Both suites drive
// the SAME mechanism (place-ansiwise.ts) through the SAME two steps (deploy-slave.ts), so a second
// copy of this would be two scripted machines that could disagree about what a placed one looks
// like — place-ansiwise.test.ts is about the two executables, place-ansiwise.service.test.ts about
// the machine's own resident surface.

export const ELEVATION = "elevation-password-SECRET-0007";

/** The ports the step takes, with one of them left out where a test is about an installation that
 *  did not configure it, or a manager that was built without a release reader at all. */
export function ports(h: Harness, variant?: "download-url" | "no-downloads"): DeploySlavePorts & AnsiwisePorts {
  return {
    platformRepo: h.platformRepo,
    ...(variant === "download-url" ? {} : { ansiwiseDownloadUrl: ANSIWISE_DOWNLOAD_URL }),
    ...(variant === "no-downloads" ? {} : { releaseDownloads: h.releases }),
  };
}

/** One step run against the scripted slave. */
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

/** What was WRITTEN to the machine, in order, from `from` onwards — the whole of what the transfer
 *  half of a placement can be asserted on. Empty means the run transferred nothing, which is what a
 *  second run onto a machine already carrying the pin has to look like.
 *
 *  `from` is how a test says "what this RUN wrote" on a machine that already carried something: the
 *  files a test planted before the step are the machine's state and have to stay readable, so they
 *  are skipped rather than cleared — clearing them would make the machine answer `--version` with
 *  nothing and turn every such test into a bare machine.  */
export function transferred(hosts: HostsScript, from = 0): { path: string; content: string; mode: number }[] {
  return hosts.files.slice(from).map((f) => ({ path: f.path, content: f.content, mode: f.mode }));
}

/** Every command the step ran on the machine, in order. A bootstrap that composed a script would
 *  show up here as a line with a shell in it — and there is one assertion that says so. */
export function commands(hosts: HostsScript): string[] {
  return hosts.log.map((l) => l.command);
}
