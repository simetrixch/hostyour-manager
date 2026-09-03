import { sql, eq, and } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events, steps } from "../db/schema/runs.ts";
import { servers } from "../db/schema/inventory.ts";
import type { RunEventBus } from "./bus.ts";
import type { CredentialStore } from "../security/store.ts";
import { HostKeyMismatchError, type SshFactory, type SshSession, type SshTarget } from "../adapters/ssh/port.ts";
import { redact } from "../security/redact.ts";
import { evtId } from "../kernel/ids.ts";
import { AppError, errUndeclaredTarget, errMissingRunSecret, errValidation } from "../kernel/errors.ts";
import type { Logger } from "../kernel/logger.ts";
import { isMasterRole, EPHEMERAL_STREAM, type RunOutputStream } from "../../shared/enums.ts";
import type { StepCtx, Cleanup, RunSecrets, RunTargetRef } from "./types.ts";
import { resolveTransport, VIA_LABEL, type ResolvedTransport, type SshTransport } from "./transport.ts";

export interface RunContextDeps {
  runId: string;
  db: Db;
  creds: CredentialStore;
  bus: RunEventBus;
  logger: Logger;
  params: Readonly<Record<string, unknown>>;
  secrets: RunSecrets;
  signal: AbortSignal;
  sshFactory: SshFactory;
  targetServerId: string | undefined; // the run's ownsHost target (for ctx.ssh() with no arg)
  /** Every target the plan declares it touches: the getSsh gate, and the ONE place a run states
   *  which of a server's two addresses it is reached on. */
  declaredTargets: readonly RunTargetRef[];
}

interface StepCheckpoint {
  data?: unknown;
  __cleanups?: string[];
}

/**
 * One RunContext per run; produces a StepCtx per step. log() is the
 * single write path for run output (redacts, assigns the per-run seq, persists to events,
 * publishes to the bus — except the ephemeral stream, which is published and never persisted).
 * The seq counter is initialized from MAX(seq) so a resumed run continues the sequence
 * without gaps.
 */
export class RunContext {
  private seq: number;
  // One SSH session PER target server AND PER ADDRESS (one session per target host and address). A run that touches >1
  // host (slave + master) must never share a single cached session, or a master-side step silently
  // runs on the slave — and the address belongs in the key for the same reason: a run kind that asked
  // for the public address because the other one may be dead must never be handed a session that
  // went out on the other one. An entry whose transport has died is dropped rather than returned
  // (getSsh). close() closes every entry.
  private readonly sshSessions = new Map<string, SshSession>();
  // Every server the plan declares it touches, mapped to the address it declared for that host.
  // The KEY SET is the plan-gate for a non-default ctx.ssh(id); the VALUE is what the target
  // builders resolve against.
  private readonly declared: ReadonlyMap<string, SshTransport>;
  private passwordSession: SshSession | undefined; // The password door (openPasswordSession)
  private readonly cleanups: Cleanup[] = [];

  constructor(private readonly d: RunContextDeps) {
    const row = d.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${events.seq}), -1)` })
      .from(events)
      .where(eq(events.runId, d.runId))
      .get();
    this.seq = (row?.maxSeq ?? -1) + 1;
    this.declared = new Map(d.declaredTargets.map((t) => [t.serverId, t.transport ?? "default"]));
  }

  forStep(stepName: string, stepId: string): StepCtx {
    return {
      runId: this.d.runId,
      stepName,
      db: this.d.db,
      creds: this.d.creds,
      params: this.d.params,
      secrets: this.d.secrets,
      signal: this.d.signal,
      logger: this.d.logger.child({ step: stepName }),
      ssh: (serverId?: string) => this.getSsh(serverId, stepId),
      openPasswordSession: (secretName: string) => this.openPasswordSession(secretName, stepId),
      closePasswordSession: () => this.closePasswordSession(),
      attest: (serverId?: string) => this.attest(serverId),
      log: (stream: RunOutputStream, text: string) => this.emit(stepId, stream, text),
      checkpoint: (data: unknown) => this.checkpoint(stepName, data),
      readCheckpoint: <T>() => this.readCheckpoint<T>(stepName),
      registerCleanup: (c: Cleanup) => {
        this.cleanups.push(c);
        this.appendCleanupName(stepName, c.name);
      },
    };
  }

  emitMeta(text: string): void {
    this.emit(null, "meta", text);
  }

  registeredCleanups(): Cleanup[] {
    return this.cleanups;
  }

  close(): void {
    for (const session of this.sshSessions.values()) session.close();
    this.sshSessions.clear();
    this.passwordSession?.close();
    this.passwordSession = undefined;
  }

  // THE PASSWORD DOOR. A password-authed session to the run's ownsHost target, opened once and
  // reused by every step that asks for it until closePasswordSession(). The secret's NAME comes from
  // the caller, because the run kind holding the password is the thing that knows what it is called.
  //
  // THE PIN GOES INTO THE TARGET, and that is what keeps the password on this side of the wire when
  // the machine is not the one this manager recorded. ssh2's hostVerifier (adapters/ssh/ssh2-session.ts)
  // decides during key exchange — before the client authenticates — so a target carrying the row's
  // fingerprint ends the connect with a HostKeyMismatchError while the credential is still unsent.
  // A check taken from session.hostKeyFingerprint() AFTER the session opens can only refuse a machine
  // that already has the password, which is a refusal that protects nothing. The key path builds its
  // target the same way (getSsh below).
  //
  // AND THE ROW IS RECORDED OR VERIFIED, never overwritten. A row holding no host key is a machine
  // this manager is meeting for the first time, so what it presents is recorded; a row holding the
  // same key is verified and nothing is written; a row holding a different one is refused with both
  // fingerprints named. attestMachineId (executor/attest.ts) has this shape for /etc/machine-id and
  // for the same reason: a write that happens on every connect turns the pin into a record of the
  // last connection rather than a claim about the machine, and then it can never disagree.
  private async openPasswordSession(secretName: string, stepId: string): Promise<SshSession> {
    if (this.passwordSession) return this.passwordSession;
    const id = this.d.targetServerId;
    if (!id) throw errUndeclaredTarget("(no target server)");
    const server = this.d.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!server) throw errUndeclaredTarget(id);
    const password = this.d.secrets.get(secretName);
    if (!password) throw errMissingRunSecret(secretName);
    const pinned = (server.preflightJson as { hostKey?: string } | null)?.hostKey;
    const resolved = resolveTransport(server, this.transportOf(id));
    this.emitConnecting(stepId, server, resolved);
    const target: SshTarget = {
      host: resolved.host,
      port: server.sshPort,
      username: server.sshUser,
      auth: { kind: "password", password },
      ...(pinned ? { hostKeyFingerprint: pinned } : {}),
    };
    let session: SshSession;
    try {
      session = await this.d.sshFactory(target);
    } catch (err) {
      // The verifier's own refusal, which is the one that matters: it happens during key exchange, so
      // the password is still on this side. It is re-thrown as the refusal a person reads, because a
      // transport-level message can name the two fingerprints but not the act that settles them.
      if (err instanceof HostKeyMismatchError) throw this.hostKeyRefusal(id, server.name, `${resolved.host}:${server.sshPort}`, err.expected, err.found);
      throw err;
    }
    const observed = session.hostKeyFingerprint();
    if (!pinned) {
      const pf = (server.preflightJson as Record<string, unknown> | null) ?? {};
      this.d.db.update(servers).set({ preflightJson: { ...pf, hostKey: observed } }).where(eq(servers.id, id)).run();
      this.emit(stepId, "meta", `No host key is recorded for ${server.name}, so the one this machine presented is recorded: ${observed}. Every later session to it is pinned on this.`);
    } else if (observed !== pinned) {
      // The second guard, over a factory whose verifier did not refuse. The session is closed and
      // never cached, because a transport to the wrong machine must not outlive the refusal.
      session.close();
      throw this.hostKeyRefusal(id, server.name, `${resolved.host}:${server.sshPort}`, pinned, observed);
    } else {
      this.emit(stepId, "meta", `The host key ${observed} is the one recorded for ${server.name}, so the pin is verified and nothing is written.`);
    }
    this.passwordSession = session;
    return session;
  }

  /** THE ONE REFUSAL FOR A MACHINE THAT IS NOT THE RECORDED ONE, whichever of the two guards above
   *  reaches it. It names both fingerprints so a person has the disagreement in front of them, and it
   *  names the act itself: a machine that was rebuilt presents a new host key, this manager cannot
   *  tell that from another machine answering at the address, and the difference is a statement a
   *  person makes on the server's card (domains/inventory/machine-identity.ts).
   *
   *  THE OBSERVED NUMBER IS EVIDENCE AND NOT THE STATEMENT. What ends the refusal is the fingerprint
   *  read off the machine's own console; the one printed here is whatever answered at the address,
   *  which is exactly what the person is being asked to go and check. */
  private hostKeyRefusal(serverId: string, name: string, address: string, expected: string, got: string): AppError {
    return errValidation(
      `refusing the password door to ${name}: this manager has ${expected} pinned as its host key and the machine at ${address} presented ${got}. ` +
      `A rebuilt machine presents a key this manager never recorded, and so does a different machine answering at the address; ` +
      `the two read the same here and only somebody at the machine can tell them apart. ` +
      `Read the fingerprint off ${name} itself and state it on this server's card under Servers, and the next run opens the door on it.`,
      { serverId, expected, got },
    );
  }

  private closePasswordSession(): void {
    this.passwordSession?.close();
    this.passwordSession = undefined;
  }

  private emit(stepId: string | null, stream: RunOutputStream, text: string): void {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      const line = redact(raw);
      const seq = this.seq++;
      // The ephemeral stream is the bus-only half: the line reaches the live SSE watcher and is
      // NEVER written to the append-only events table — the channel for the activate_url, which the
      // watching operator must see once and no later reader may ever recover from the DB. The seq
      // is still consumed, so a persisted line never reuses a seq an SSE client already saw (the
      // reconnect cursor filters on seq and would silently drop that line).
      if (stream !== EPHEMERAL_STREAM) {
        this.d.db.insert(events).values({ id: evtId(), runId: this.d.runId, stepId, stream, seq, text: line }).run();
      }
      this.d.bus.publish(this.d.runId, { seq, stream, text: line, at: Date.now() });
    }
  }

  private stepCheckpoint(stepName: string): StepCheckpoint {
    const row = this.d.db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, this.d.runId), eq(steps.name, stepName)))
      .get();
    return (row?.checkpointJson as StepCheckpoint | null) ?? {};
  }

  private writeCheckpoint(stepName: string, cp: StepCheckpoint): void {
    this.d.db
      .update(steps)
      .set({ checkpointJson: cp })
      .where(and(eq(steps.runId, this.d.runId), eq(steps.name, stepName)))
      .run();
  }

  private checkpoint(stepName: string, data: unknown): void {
    const json = JSON.stringify(data);
    if (redact(json) !== json) throw new AppError("INTERNAL", "checkpoint contains a registered secret");
    this.writeCheckpoint(stepName, { ...this.stepCheckpoint(stepName), data });
  }

  private readCheckpoint<T>(stepName: string): T | undefined {
    return this.stepCheckpoint(stepName).data as T | undefined;
  }

  private appendCleanupName(stepName: string, name: string): void {
    const cp = this.stepCheckpoint(stepName);
    const names = new Set(cp.__cleanups ?? []);
    names.add(name);
    this.writeCheckpoint(stepName, { ...cp, __cleanups: [...names] });
  }

  // ctx.attest() implementation is still missing. Interface is final; noop never calls it.
  private attest(_serverId?: string): Promise<void> {
    return Promise.reject(new AppError("INTERNAL", "ctx.attest() is not implemented"));
  }

  // Multi-target SSH (one session per target host and address). Resolves the effective serverId (no arg = the run's
  // ownsHost/primary target) and the address the plan declared for it, then returns the session
  // cached for THAT pair or opens a new one: the newest ssh_key for the server, connect, memzero
  // the key. A run that alternates between the slave and the master thus gets one
  // session per host, never a shared one. noop never calls this.
  private async getSsh(serverId: string | undefined, stepId: string): Promise<SshSession> {
    const id = serverId ?? this.d.targetServerId;
    if (!id) throw errUndeclaredTarget("(no target server)");
    // Plan-gate: the primary/default target is always reachable; any OTHER serverId a step
    // asks for must be one the plan declared it touches, else it is refused.
    if (id !== this.d.targetServerId && !this.declared.has(id)) throw errUndeclaredTarget(id);
    const server = this.d.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!server) throw errUndeclaredTarget(id);
    // The row is read BEFORE the cache is consulted, because the address it resolves to is half
    // the cache key — a session is only the right one if it went out on the address this call asks
    // for.
    const resolved = resolveTransport(server, this.transportOf(id));
    const key = `${id}@${resolved.via}`;
    const cached = this.sshSessions.get(key);
    if (cached && !cached.isClosed()) return cached;
    if (cached) {
      // The transport died under the cached session — the adapter tears its client down after three
      // unanswered keepalives, which a command that takes the host's own networking down outlives
      // (the tailnet repair run kinds are made of exactly such commands). Handing it back would fail
      // every remaining step on a bare "not connected" instead of reopening on the same address, and
      // the run log would not even say the connection had been lost.
      this.sshSessions.delete(key);
      cached.close();
      this.emit(stepId, "meta", `The session to ${server.name} over its ${VIA_LABEL[resolved.via]} is gone — opening a new one.`);
    }
    // excludeRotated + createdAt ordering ⇒ [length-1] is the newest ACTIVE key (a rotated-out
    // key must never be picked up).
    const creds = await this.d.creds.list({ serverId: id, kind: "ssh_key", excludeRotated: true });
    const cred = creds[creds.length - 1];
    if (!cred) throw new AppError("INTERNAL", `no ssh_key credential for server ${id}`);
    const pinned = (server.preflightJson as { hostKey?: string } | null)?.hostKey;
    // Defense in depth: the master is SSHed-to by deploy-slave (this control host). Without a
    // pinned host key the connection would trust-on-first-use with an accept-any verifier —
    // MITM-able. Refuse rather than connect unpinned. Slaves are unaffected (only the
    // master requires the pin; a slave without a recorded host key still connects TOFU).
    if (isMasterRole(server.role) && !pinned) {
      throw errValidation(
        `refusing to connect to the master "${server.name}" without a pinned host key — provision the host-key pin first (MASTER_SSH_HOST_KEY_FP → preflightJson.hostKey)`,
      );
    }
    const privateKey = await this.d.creds.open(cred.id, { purpose: "run:ssh", runId: this.d.runId });
    try {
      const target: SshTarget = {
        host: resolved.host,
        port: server.sshPort,
        username: server.sshUser,
        auth: { kind: "key", privateKey },
        ...(pinned ? { hostKeyFingerprint: pinned } : {}),
      };
      this.emitConnecting(stepId, server, resolved);
      const session = await this.d.sshFactory(target);
      this.sshSessions.set(key, session);
      return session;
    } finally {
      privateKey.fill(0);
    }
  }

  /** The transport the plan declared for this host. A target the plan never named — the derived
   *  owns-host target of a plan that lists none — gets the default, which is what every run did
   *  before a run could state one at all. */
  private transportOf(serverId: string): SshTransport {
    return this.declared.get(serverId) ?? "default";
  }

  /** Name the address a session is about to go out on, BEFORE the connect. Written on the way out
   *  rather than after, because the line matters most when the connect never returns: a step that
   *  fails to reach a host must say which of the host's two addresses it failed on. */
  private emitConnecting(stepId: string, server: typeof servers.$inferSelect, resolved: ResolvedTransport): void {
    this.emit(stepId, "meta",
      `Connecting to ${server.name} over its ${VIA_LABEL[resolved.via]}: ${server.sshUser}@${resolved.host}:${server.sshPort}`);
  }
}
