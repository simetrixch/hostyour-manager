import { pino, type Logger } from "pino";
import { z } from "zod";
import type { DbHandle } from "../db/client.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

// The world the queue's tests run in, shared with the stamp test of a run the queue dispatches.

export const SECRET = "consumer-secret:ROOT_PASSWORD";
const silent = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

const params = z.object({ name: z.string(), locks: z.array(z.string()), secret: z.boolean().optional() });
type Params = z.infer<typeof params>;

/** A world of runs whose one step each test steers by name: `failing` names fail, `blocking` names
 *  wait until the test opens their gate. Every run claims the git branches it names. */
export function world() {
  const failing = new Set<string>();
  const blocking = new Map<string, () => void>();
  const started: string[] = [];
  const def: AnyRunDefinition = {
    kind: "noop",
    paramsSchema: params,
    mutating: false,
    plan: async (p: Params) => ({
      kind: "noop", targetKind: "self", targetId: "manager", summary: p.name,
      steps: [{ name: "change", title: "Change" }], warnings: [], requiredSecrets: p.secret ? [SECRET] : [],
      locks: p.locks.map((key) => ({ resource: "git-branch" as const, key })),
    }),
    steps: (p: Params) => [{
      name: "change",
      title: "Change",
      run: async () => {
        started.push(p.name);
        if (blocking.has(p.name)) await new Promise<void>((r) => { blocking.set(p.name, r); });
        if (failing.has(p.name)) throw new Error("half done");
      },
    }],
  } as AnyRunDefinition;
  return { def, failing, blocking, started, open: (name: string) => blocking.get(name)?.() };
}

/** An Executor over `db` that knows the world's one kind and reaches no host. */
export function executorOver(db: DbHandle, def: AnyRunDefinition, log: Logger = silent): Executor {
  return new Executor({
    db: db.db, creds: new CredentialStore({ db: db.db, logger: log }), bus: new RunEventBus(), logger: log,
    runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]), sshFactory: noSsh,
  });
}

export const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); };
export const plan = async (ex: Executor, name: string, locks: string[], secret = false) => (await ex.plan("noop", { name, locks, secret })).runId;
