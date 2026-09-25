// The keys the unit plugin reads (server/plugin.ts `env`): parsed only while PLUGINS names the plugin,
// and refused at boot while it does not (server/boot/plugin-set.ts).
import { z } from "zod";
import type { StorageBoxAccess } from "./relocation-jobs.ts";

export const UnitEnv = z.object({
  // The Hetzner Storage Box behind move, backup and restore: the staging area every dump
  // lands on and every restore reads from, reachable over SSH. The three values come from
  // secret/<stage>/app/storage-box via the manager's own ExternalSecret (the seeder is write-only,
  // so like GITHUB_WEBHOOK_SECRET they arrive as env, never as a Vault read-back). ALL THREE or NONE —
  // a partial config is a boot error. Absent ⇒ the backup/restore/migrate dump steps fail loud.
  STORAGE_BOX_HOST: z.string().min(1).optional(),
  STORAGE_BOX_USER: z.string().min(1).optional(),
  STORAGE_BOX_PASSWORD: z.string().min(1).optional(),
  // The pinned dbtools job image (<registry-host>/dbtools:<tag>) the relocation Jobs
  // run — mongodb tools, postgresql client, an S3 client and SSH for the staging area. The pin lives
  // as a builds[] entry in apps/manager/values-<stage>.yaml and the Deployment projects it here,
  // the same road MANAGER_VERSION travels. Absent ⇒ the dump/restore steps fail loud.
  DBTOOLS_IMAGE: z.string().min(1).optional(),
}).refine((e) => {
  const set = [e.STORAGE_BOX_HOST, e.STORAGE_BOX_USER, e.STORAGE_BOX_PASSWORD].filter(Boolean).length;
  return set === 0 || set === 3;
}, {
  message: "STORAGE_BOX_HOST, STORAGE_BOX_USER and STORAGE_BOX_PASSWORD must be set together (the staging area needs all three, or none)",
  path: ["STORAGE_BOX_HOST"],
});

export interface UnitConfig {
  /** Present ⇒ the Hetzner Storage Box is wired: the SSH staging area every relocation dump lands
   *  on. Absent ⇒ the dump/restore steps fail loud — the box is a mandatory part of the run kinds. */
  storageBox?: StorageBoxAccess;
  /** The pinned dbtools job image the relocation Jobs run. Absent ⇒ those steps fail loud. */
  dbtoolsImage?: string;
}

export function unitConfig(e: z.output<typeof UnitEnv>): UnitConfig {
  return {
    // The refine above guarantees the three together; the triple guard narrows them.
    ...(e.STORAGE_BOX_HOST && e.STORAGE_BOX_USER && e.STORAGE_BOX_PASSWORD
      ? { storageBox: { host: e.STORAGE_BOX_HOST, user: e.STORAGE_BOX_USER, password: e.STORAGE_BOX_PASSWORD } }
      : {}),
    ...(e.DBTOOLS_IMAGE ? { dbtoolsImage: e.DBTOOLS_IMAGE } : {}),
  };
}
