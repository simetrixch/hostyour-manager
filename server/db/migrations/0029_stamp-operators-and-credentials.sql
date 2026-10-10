-- The stamp columns (db/schema/stamps.ts) on operators, operator_keys, meta, revoked_sessions and
-- credentials, and the deletion columns on operator_keys and credentials, by table rebuilds. Every row
-- is carried with the times and actors it recorded:
--   operators         creation = modified = created_at. A row a sign-in wrote belongs to that operator,
--                     as its `operator.upserted` audit row records, and only the operator's own sign-in
--                     changes it. Nothing recorded who wrote the two seeded operators.
--   operator_keys     creation = modified = created_at, owner = modified_by = created_by: a key is
--                     never changed after it is added.
--   meta              no writer ever set updated_at, so it holds the time of the first write:
--                     creation = modified = updated_at.
--   revoked_sessions  nothing recorded when or by whom a session was revoked: the migration's time.
--   credentials       creation = created_at; modified is the last recorded time. The owner is the actor
--                     of its `credential.created` audit row, modified_by the actor of its last audit
--                     row, or the owner where the credential never changed. A rotation is audited on
--                     the new credential and names the old one under `supersedes`.
-- An actor nothing recorded is `unrecorded`.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_operators` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`subject` text,
	`email` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_operators`("id", "username", "display_name", "subject", "email", "creation", "modified", "owner", "modified_by")
SELECT o."id", o."username", o."display_name", o."subject", o."email", o."created_at", o."created_at", o."writer", o."writer"
FROM (SELECT p.*,
	CASE WHEN EXISTS (SELECT 1 FROM `audit` a WHERE a."action" = 'operator.upserted' AND a."owner" = p."id") THEN p."id" ELSE 'unrecorded' END AS "writer"
	FROM `operators` p) o;--> statement-breakpoint
DROP TABLE `operators`;--> statement-breakpoint
ALTER TABLE `__new_operators` RENAME TO `operators`;--> statement-breakpoint
CREATE UNIQUE INDEX `operators_username_uq` ON `operators` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `operators_subject_uq` ON `operators` (`subject`) WHERE subject IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_operator_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`public_key` text NOT NULL,
	`type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text
);
--> statement-breakpoint
INSERT INTO `__new_operator_keys`("id", "label", "public_key", "type", "fingerprint", "creation", "modified", "owner", "modified_by")
SELECT "id", "label", "public_key", "type", "fingerprint", "created_at", "created_at", "created_by", "created_by" FROM `operator_keys`;--> statement-breakpoint
DROP TABLE `operator_keys`;--> statement-breakpoint
ALTER TABLE `__new_operator_keys` RENAME TO `operator_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `operator_keys_label_uq` ON `operator_keys` (`label`) WHERE deleted IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `operator_keys_fingerprint_uq` ON `operator_keys` (`fingerprint`) WHERE deleted IS NULL;--> statement-breakpoint
CREATE TABLE `__new_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_meta`("key", "value", "creation", "modified", "owner", "modified_by")
SELECT "key", "value", "updated_at", "updated_at", 'unrecorded', 'unrecorded' FROM `meta`;--> statement-breakpoint
DROP TABLE `meta`;--> statement-breakpoint
ALTER TABLE `__new_meta` RENAME TO `meta`;--> statement-breakpoint
CREATE TABLE `__new_revoked_sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_revoked_sessions`("jti", "expires_at", "owner", "modified_by")
SELECT "jti", "expires_at", 'unrecorded', 'unrecorded' FROM `revoked_sessions`;--> statement-breakpoint
DROP TABLE `revoked_sessions`;--> statement-breakpoint
ALTER TABLE `__new_revoked_sessions` RENAME TO `revoked_sessions`;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`purpose` text NOT NULL,
	`encrypted_blob` text,
	`fingerprint` text NOT NULL,
	`public_key` text,
	`last_used_at` integer,
	`rotated_at` integer,
	`revoked_at` integer,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text,
	CONSTRAINT "credentials_blob_ck" CHECK(encrypted_blob IS NOT NULL OR deleted IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_credentials`("id", "kind", "label", "subject_kind", "subject_id", "purpose", "encrypted_blob", "fingerprint", "public_key", "last_used_at", "rotated_at", "revoked_at", "creation", "modified", "owner", "modified_by")
SELECT c."id", c."kind", c."label", c."subject_kind", c."subject_id", c."purpose", c."encrypted_blob", c."fingerprint", c."public_key", c."last_used_at", c."rotated_at", c."revoked_at",
	c."created_at",
	max(c."created_at", coalesce(c."last_used_at", 0), coalesce(c."rotated_at", 0), coalesce(c."revoked_at", 0)),
	c."creator",
	coalesce(
		(SELECT a."owner" FROM `audit` a
			WHERE (a."target_kind" = 'credential' AND a."target_id" = c."id")
				OR (a."action" = 'credential.rotated' AND json_extract(a."detail_json", '$.supersedes') = c."id")
			ORDER BY a."creation" DESC, a."id" DESC LIMIT 1),
		CASE WHEN coalesce(c."last_used_at", c."rotated_at", c."revoked_at") IS NULL THEN c."creator" ELSE 'unrecorded' END)
FROM (SELECT k.*,
	coalesce((SELECT a."owner" FROM `audit` a WHERE a."target_kind" = 'credential' AND a."target_id" = k."id" AND a."action" = 'credential.created' ORDER BY a."creation", a."id" LIMIT 1), 'unrecorded') AS "creator"
	FROM `credentials` k) c;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
CREATE INDEX `credentials_subject_ix` ON `credentials` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `credentials_fingerprint_ix` ON `credentials` (`fingerprint`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
