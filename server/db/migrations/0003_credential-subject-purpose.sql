-- Every credential gains an OWNER and a PURPOSE (hostyour-manager#225), carried over from what the
-- rows already say — the server they belong to, the organisation naming them, the kind, the
-- fingerprint marker, the label's parenthesised unit — inside the one table rebuild drizzle-kit
-- generated for the column additions. The three columns stay nullable in this step so the rebuild
-- can copy every standing row; 0004 makes them required, drops server_id and the table of
-- organisation ids the SELECT below reads.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`server_id` text,
	`subject_kind` text,
	`subject_id` text,
	`purpose` text,
	`encrypted_blob` text NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	`rotated_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_credentials`("id", "kind", "label", "server_id", "subject_kind", "subject_id", "purpose", "encrypted_blob", "fingerprint", "public_key", "created_at", "last_used_at", "rotated_at", "revoked_at")
SELECT "id", "kind", "label", "server_id",
  CASE
    WHEN "server_id" IS NOT NULL THEN 'server'
    WHEN "id" IN (SELECT "packages_credential_id" FROM `organisation_identities` UNION SELECT "repo_credential_id" FROM `organisation_identities`) THEN 'organisation'
    ELSE 'unit'
  END,
  CASE
    WHEN "server_id" IS NOT NULL THEN "server_id"
    WHEN "id" IN (SELECT "packages_credential_id" FROM `organisation_identities`) THEN (SELECT "org" FROM `organisation_identities` WHERE "packages_credential_id" = `credentials`."id")
    WHEN "id" IN (SELECT "repo_credential_id" FROM `organisation_identities`) THEN (SELECT "org" FROM `organisation_identities` WHERE "repo_credential_id" = `credentials`."id")
    WHEN instr("label", '(') > 0 THEN substr("label", instr("label", '(') + 1, length("label") - instr("label", '(') - 1)
    ELSE "label"
  END,
  CASE
    WHEN "kind" = 'ssh_key' THEN 'ssh-key'
    WHEN "kind" = 'kubeconfig' THEN 'cluster-bearer'
    WHEN "kind" = 'other' AND "fingerprint" = 'bootstrap-password' THEN 'bootstrap-password'
    WHEN "kind" = 'other' THEN 'reviewer-jwt'
    WHEN "id" IN (SELECT "packages_credential_id" FROM `organisation_identities`) THEN 'packages-reader'
    WHEN "id" IN (SELECT "repo_credential_id" FROM `organisation_identities`) THEN 'repository-pat'
    ELSE 'repository-identity'
  END,
  "encrypted_blob", "fingerprint", "public_key", "created_at", "last_used_at", "rotated_at", "revoked_at" FROM `credentials`;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `credentials_server_ix` ON `credentials` (`server_id`);--> statement-breakpoint
CREATE INDEX `credentials_fingerprint_ix` ON `credentials` (`fingerprint`);
