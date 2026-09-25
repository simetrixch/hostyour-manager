import { registerSecret, unregisterScope } from "../security/redact.ts";
import type { RunSecrets } from "./types.ts";

/**
 * Memory-only run secrets. Backed by a plain Map inside the process —
 * never the DB, never pino. Registering a value with the redactor means an accidental
 * echo of it in output is masked. Wiped (zeroed) at the run's terminal state, and by
 * design lost on process restart — a run resumed after a crash must have its secret handed in again
 * rather than find a stale copy.
 */
export class RunSecretsMap implements RunSecrets {
  private readonly map = new Map<string, Buffer>();

  constructor(private readonly scope: string) {}

  set(name: string, value: Buffer): void {
    this.map.set(name, value);
    registerSecret(this.scope, value);
  }

  get(name: string): Buffer | undefined {
    return this.map.get(name);
  }

  wipe(name?: string): void {
    if (name === undefined) {
      for (const b of this.map.values()) b.fill(0);
      this.map.clear();
      unregisterScope(this.scope);
      return;
    }
    this.map.get(name)?.fill(0);
    this.map.delete(name);
  }
}
