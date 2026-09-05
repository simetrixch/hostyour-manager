// The ansiwise REST surface, as this repository types it. Pure types + zod contracts + error
// classes — no node:http here, so a domain def can depend on the port, not the transport.
//
// The surface itself lives in ansiwise-rest (deployment_api.dart): six routes, JSON objects,
// NDJSON for a run's events. What is typed here is only what the manager READS — the schemas
// keep the fields the steps act on and drop the rest, so a machine that grows a field does not
// break a manager that never looked at it.
//
// AND THERE IS NO ADDRESS HERE, WHICH IS THE POINT. The client is handed an already-open
// conversation with `ansiwise-rest serve` and nothing else, so a host, a port and a bearer token
// cannot be given to it at all: the manager reaches a machine over the session sshd has already
// authenticated, and the type is what says there is no second way (simetrixch/ansiwise-cli#14).

import { z } from "zod";

/** One declared answer of a program (`GET /programs/{name}`.answers[]) — what the manager reads
 *  to know WHICH answers to compose, so the answer list lives in the machine's own catalogue and
 *  never as a copy here. */
export const AnsiwiseAnswerSpec = z.object({
  name: z.string(),
  required: z.boolean(),
  secret: z.boolean(),
});
export type AnsiwiseAnswerSpec = z.infer<typeof AnsiwiseAnswerSpec>;

export const AnsiwiseProgram = z.object({
  name: z.string(),
  roles: z.array(z.string()),
  answers: z.array(AnsiwiseAnswerSpec),
});
export type AnsiwiseProgram = z.infer<typeof AnsiwiseProgram>;

/** What `POST /runs` answers with 202: the run is ACCEPTED, not finished. `admitted_by` names
 *  the green dry run that let a real run through the machine's own gate; `waived` says which
 *  proof the installation waived — read, never inferred. */
export const AnsiwiseRunAccepted = z.object({
  run: z.string(),
  program: z.string(),
  mode: z.string(),
  fingerprint: z.string(),
  resumes: z.string().optional(),
  admitted_by: z.string().optional(),
  waived: z.array(z.string()).optional(),
});
export type AnsiwiseRunAccepted = z.infer<typeof AnsiwiseRunAccepted>;

/** A run's record (`GET /runs/{id}`), reduced to what a follower judges: `end` absent means the
 *  run is still going, and `exit_code` is the machine's own verdict — the record is the truth a
 *  step asserts on, never the event stream, which can be cut mid-line. */
export const AnsiwiseRunRecord = z.object({
  id: z.string(),
  program: z.string(),
  mode: z.string(),
  fingerprint: z.string(),
  end: z.string().optional(),
  exit_code: z.number().int().optional(),
  issues: z.array(z.string()),
});
export type AnsiwiseRunRecord = z.infer<typeof AnsiwiseRunRecord>;

/** One event of a run (`GET /runs/{id}/events?from=N`, one JSON object per NDJSON line).
 *  `sequence` numbers are dense and never reused — that is what makes `from` a resume point
 *  where a dropped connection costs nothing. The detail fields are each kind's; every one the
 *  manager renders into a run log is optional here so one schema reads every kind. */
export const AnsiwiseEvent = z.object({
  kind: z.string(),
  sequence: z.number().int(),
  step: z.string().optional(),
  program: z.string().optional(),
  mode: z.string().optional(),
  stream: z.string().optional(),
  text: z.string().optional(),
  level: z.string().optional(),
  message: z.string().optional(),
  argv: z.array(z.string()).optional(),
  exit_code: z.number().int().optional(),
  issues: z.array(z.string()).optional(),
  verdict: z.object({ label: z.string(), reason: z.string().optional() }).optional(),
});
export type AnsiwiseEvent = z.infer<typeof AnsiwiseEvent>;

/** What `POST /runs` takes. The envelope is the machine's: answers beside the password that
 *  raises a command to root, which belongs to the RUN it starts and is never persisted here. */
export interface AnsiwiseStart {
  program: string;
  mode: "test" | "dry" | "run";
  answers?: Record<string, unknown>;
  elevationPassword?: string;
  resumes?: string;
}

/** The machine answered, and said no — its own sentence, verbatim, because the machine's gate
 *  and validation write better refusals than a paraphrase would. 409 is the run gate ("not yet:
 *  no green dry run of this input"), 400 a rejected input, 404 a name nothing carries. */
export class AnsiwiseRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "AnsiwiseRefused";
  }
}

/** Nothing answered, or the answer was not the surface's shape — a transport fault, not a
 *  refusal. The two are acted on differently: a refusal is final, a fault is re-attached to. */
export class AnsiwiseUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnsiwiseUnreachable";
  }
}
