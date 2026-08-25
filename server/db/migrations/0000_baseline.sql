-- The schema, in ONE migration. The tables and indexes are what drizzle-kit generates from
-- server/db/schema/*.ts; the two sections after them are what it cannot produce — the append-only
-- triggers and the reserved system operators. Regenerating this file drops both; re-add them at the
-- end, after the tables they touch exist.
--
-- ONE GENERATED LINE ALSO HAS TO BE REPAIRED BY HAND, and it fails loudly rather than quietly:
-- `servers_one_master_uq` is an index over an EXPRESSION, and the generator's SQL emitter splits
-- that expression on its comma and backtick-quotes each half as if it were a column name. The
-- snapshot holds the expression correctly, so only the SQL is wrong, and a database built from the
-- unrepaired file dies inside migrate() with `no such column: (role IN ('master'`. After every
-- regeneration put the line back to a single parenthesised expression:
--   CREATE UNIQUE INDEX `servers_one_master_uq` ON `servers` ((role IN ('master', 'master+slave')))
--   WHERE role IN ('master', 'master+slave');
--
-- THERE IS EXACTLY ONE MIGRATION AND THIS FILE IS THE SCHEMA. A column change is made here, inside
-- the CREATE TABLE, and never as a second migration beside it. Nothing has run an older shape of it:
-- every install is a fresh install, and a development database on a machine is recreated rather than
-- migrated. A stored-value change — a run kind or a provenance word respelled — is therefore made in
-- the CREATE TABLE default and in the writers, with no ALTER and no UPDATE carrying old rows across,
-- because there are no old rows to carry.
--
-- EVERY CHUNK BETWEEN TWO BREAKPOINT MARKERS MUST CONTAIN A STATEMENT. The migrator splits this
-- file on the marker drizzle writes between statements and prepares each chunk, so a chunk holding
-- only a comment is not something it can prepare — it dies at boot on the comment text itself. Two
-- consequences: a note always stands BEFORE the statement it is about, inside that statement's own
-- chunk, never alone at the end of the file; and no comment anywhere in this file may spell that
-- marker out, because the split is a plain text search and does not know it is inside a comment.
--
-- `unit_sizes` deliberately gets NO seed rows here: the numbers live once, in shared/unit-size.ts
-- UNIT_SIZE_SEED, and boot inserts any that are missing (create-only, so an edited row is never
-- reset). Seeding them in SQL as well would put the same figures in two places, free to drift.
--
-- Every edit here also bumps `when` in meta/_journal.json. That timestamp is the migrator's ONLY
-- gate: it runs an entry when the newest created_at in __drizzle_migrations is older than the
-- entry's `when`, and it checks no hash. Left unbumped, a database holding rows from an earlier
-- shape of this file is simply skipped — it boots green with a schema short of whatever the edit
-- added and dies much later on `no such column`. Bumped, that same database fails inside migrate()
-- at boot with `table audit already exists`, which is the signal to recreate it.
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`run_id` text,
	`detail_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_ts_ix` ON `audit` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_target_ix` ON `audit` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`server_id` text,
	`encrypted_blob` text NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	`rotated_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `credentials_server_ix` ON `credentials` (`server_id`);--> statement-breakpoint
CREATE INDEX `credentials_fingerprint_ix` ON `credentials` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`repo_url` text,
	`chart_path` text,
	`repo_credential_id` text,
	`provenance` text DEFAULT 'manager' NOT NULL,
	`last_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_cluster_name_stage_uq` ON `apps` (`cluster_id`,`name`,`stage`);--> statement-breakpoint
CREATE TABLE `clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`stage` text NOT NULL,
	`domain` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`tier` text DEFAULT 'rehearsal' NOT NULL,
	`slave_id` integer,
	`plane_state` text DEFAULT 'absent' NOT NULL,
	`plane_json` text,
	`provisioned_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_server_uq` ON `clusters` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_domain_uq` ON `clusters` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_slave_id_uq` ON `clusters` (`slave_id`) WHERE slave_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`lan_host` text,
	`tailnet_host` text,
	`ssh_port` integer DEFAULT 22 NOT NULL,
	`ssh_user` text NOT NULL,
	`role` text DEFAULT 'slave' NOT NULL,
	`status` text DEFAULT 'bare' NOT NULL,
	`machine_id` text,
	`preflight_json` text,
	`tailnet_state` text DEFAULT 'unknown' NOT NULL,
	`tailnet_json` text,
	`password_login_state` text DEFAULT 'unknown' NOT NULL,
	`password_login_json` text,
	`authorized_keys_state` text DEFAULT 'unknown' NOT NULL,
	`authorized_keys_json` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`adopted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_uq` ON `servers` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_host_port_uq` ON `servers` (`host`,`ssh_port`);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_one_master_uq` ON `servers` ((role IN ('master', 'master+slave'))) WHERE role IN ('master', 'master+slave');--> statement-breakpoint
CREATE TABLE `tenant_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_run_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_apps_tenant_name_uq` ON `tenant_apps` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`guid` text NOT NULL,
	`subdomain` text NOT NULL,
	`stage` text NOT NULL,
	`identity_provider` text NOT NULL,
	`members` text NOT NULL,
	`seed_users` integer DEFAULT false NOT NULL,
	`suspended` integer DEFAULT false NOT NULL,
	`owner` text,
	`provenance` text DEFAULT 'manager' NOT NULL,
	`last_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`admin_state` text,
	`admin_count` integer,
	`admin_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_cluster_guid_uq` ON `tenants` (`cluster_id`,`guid`);--> statement-breakpoint
CREATE TABLE `unit_sizes` (
	`component` text NOT NULL,
	`name` text NOT NULL,
	`requests_cpu` text NOT NULL,
	`requests_memory` text NOT NULL,
	`limits_cpu` text NOT NULL,
	`limits_memory` text NOT NULL,
	`pods` integer NOT NULL,
	`persistent_volume_claims` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`component`, `name`)
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operator_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`public_key` text NOT NULL,
	`type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_keys_label_uq` ON `operator_keys` (`label`);--> statement-breakpoint
CREATE UNIQUE INDEX `operator_keys_fingerprint_uq` ON `operator_keys` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `operators` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`subject` text,
	`email` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operators_username_uq` ON `operators` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `operators_subject_uq` ON `operators` (`subject`) WHERE subject IS NOT NULL;--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`stream` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_seq_uq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_step_ix` ON `events` (`step_id`);--> statement-breakpoint
CREATE TABLE `run_locks` (
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`run_id` text NOT NULL,
	`acquired_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`resource`, `key`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `run_locks_run_ix` ON `run_locks` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`params_json` text NOT NULL,
	`plan_json` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`started_by` text NOT NULL,
	`approved_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`started_by`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runs_plan_json_ck" CHECK(plan_json IS NOT NULL OR status IN ('planning','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `runs_status_ix` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_target_ix` ON `runs` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `runs_created_ix` ON `runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`checkpoint_json` text,
	`skip_reason` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_ordinal_uq` ON `steps` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_name_uq` ON `steps` (`run_id`,`name`);--> statement-breakpoint
-- Append-only invariants for events + audit. A Run IS the audit record, and an audit record you can
-- rewrite is not one, so the guard is triggers rather than convention: every UPDATE and DELETE on
-- either table aborts. A retention pass drops the triggers and recreates them inside one
-- transaction — server/db/reset.ts does exactly that for the two DELETE triggers, and its
-- recreate text must stay identical to these definitions.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
-- Reserved system operators, so runs.started_by (FK -> operators, NOT NULL) is always satisfiable
-- for a run no human started: op_system is the autonomous/resume actor, op_emergency the
-- break-glass session. Without these rows a break-glass session cannot start a run at all. Real
-- operators are created by the Access domain at first OIDC login; these two never log in.
INSERT INTO operators (id, username, display_name) VALUES ('op_system', 'system', 'System');
--> statement-breakpoint
INSERT INTO operators (id, username, display_name) VALUES ('op_emergency', 'emergency', 'Break-glass');
