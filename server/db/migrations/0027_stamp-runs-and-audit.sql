-- The stamp columns (db/schema/stamps.ts) on runs, steps, events, run_locks and audit, by table
-- rebuilds: SQLite refuses an added NOT NULL column without a default on a table that holds rows.
-- Every row is carried with the times and actors it recorded:
--   runs       creation = created_at, owner = started_by, deleted = deleted_at; modified is the last
--              recorded time and modified_by the actor of the run's last audit row, or its starter
--              where the run never changed; deleted_by is the actor of its `run.deleted` audit row.
--   steps      the run's creation and owner; modified is the last recorded time; a step that moved
--              past `pending` was changed by an actor nothing recorded.
--   events     creation = ts and the run's owner; an event is written once.
--   run_locks  only held locks existed; creation = acquired_at; who acquired one was not recorded. The
--              id is the row's rowid in the shape of a minted id, so it sorts before every later one.
--   audit      creation = ts, owner = actor; the credential store's "system" is op_system now.
-- An actor nothing recorded is `unrecorded`. The rebuilds drop the append-only triggers of events and
-- audit with their tables, so both are created again.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`params_json` text NOT NULL,
	`plan_json` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`approved_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text,
	FOREIGN KEY (`owner`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runs_plan_json_ck" CHECK(plan_json IS NOT NULL OR status IN ('planning','failed','cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "kind", "target_kind", "target_id", "params_json", "plan_json", "status", "approved_at", "started_at", "finished_at", "error", "creation", "modified", "owner", "modified_by", "deleted", "deleted_by")
SELECT r."id", r."kind", r."target_kind", r."target_id", r."params_json", r."plan_json", r."status", r."approved_at", r."started_at", r."finished_at", r."error",
	r."created_at",
	max(r."created_at", coalesce(r."approved_at", 0), coalesce(r."started_at", 0), coalesce(r."finished_at", 0), coalesce(r."deleted_at", 0)),
	r."started_by",
	coalesce(
		(SELECT CASE a."actor" WHEN 'system' THEN 'op_system' ELSE a."actor" END FROM `audit` a WHERE a."run_id" = r."id" ORDER BY a."ts" DESC, a."id" DESC LIMIT 1),
		CASE WHEN coalesce(r."approved_at", r."started_at", r."finished_at", r."deleted_at") IS NULL THEN r."started_by" ELSE 'unrecorded' END),
	r."deleted_at",
	CASE WHEN r."deleted_at" IS NULL THEN NULL ELSE coalesce((SELECT CASE a."actor" WHEN 'system' THEN 'op_system' ELSE a."actor" END FROM `audit` a WHERE a."run_id" = r."id" AND a."action" = 'run.deleted' ORDER BY a."ts" DESC, a."id" DESC LIMIT 1), 'unrecorded') END
FROM `runs` r;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_status_ix` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_target_ix` ON `runs` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `runs_creation_ix` ON `runs` (`creation`);--> statement-breakpoint
CREATE TABLE `__new_steps` (
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
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_steps`("id", "run_id", "ordinal", "name", "title", "status", "started_at", "finished_at", "checkpoint_json", "skip_reason", "error", "creation", "modified", "owner", "modified_by")
SELECT s."id", s."run_id", s."ordinal", s."name", s."title", s."status", s."started_at", s."finished_at", s."checkpoint_json", s."skip_reason", s."error",
	r."creation",
	max(r."creation", coalesce(s."started_at", 0), coalesce(s."finished_at", 0)),
	r."owner",
	CASE WHEN s."status" = 'pending' AND s."started_at" IS NULL AND s."finished_at" IS NULL THEN r."owner" ELSE 'unrecorded' END
FROM `steps` s JOIN `runs` r ON r."id" = s."run_id";--> statement-breakpoint
DROP TABLE `steps`;--> statement-breakpoint
ALTER TABLE `__new_steps` RENAME TO `steps`;--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_ordinal_uq` ON `steps` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_name_uq` ON `steps` (`run_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`stream` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "run_id", "step_id", "stream", "seq", "text", "creation", "modified", "owner", "modified_by")
SELECT e."id", e."run_id", e."step_id", e."stream", e."seq", e."text", e."ts", e."ts", r."owner", r."owner"
FROM `events` e JOIN `runs` r ON r."id" = e."run_id";--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_seq_uq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_step_ix` ON `events` (`step_id`);--> statement-breakpoint
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TABLE `__new_run_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`run_id` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_run_locks`("id", "resource", "key", "run_id", "creation", "modified", "owner", "modified_by")
SELECT 'lock_' || printf('%026d', rowid), "resource", "key", "run_id", "acquired_at", "acquired_at", 'unrecorded', 'unrecorded' FROM `run_locks`;--> statement-breakpoint
DROP TABLE `run_locks`;--> statement-breakpoint
ALTER TABLE `__new_run_locks` RENAME TO `run_locks`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_locks_resource_key_uq` ON `run_locks` (`resource`,`key`) WHERE deleted IS NULL;--> statement-breakpoint
CREATE INDEX `run_locks_run_ix` ON `run_locks` (`run_id`);--> statement-breakpoint
CREATE TABLE `__new_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`run_id` text,
	`detail_json` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_audit`("id", "action", "target_kind", "target_id", "run_id", "detail_json", "creation", "modified", "owner", "modified_by")
SELECT "id", "action", "target_kind", "target_id", "run_id", "detail_json", "ts", "ts",
	CASE "actor" WHEN 'system' THEN 'op_system' ELSE "actor" END,
	CASE "actor" WHEN 'system' THEN 'op_system' ELSE "actor" END
FROM `audit`;--> statement-breakpoint
DROP TABLE `audit`;--> statement-breakpoint
ALTER TABLE `__new_audit` RENAME TO `audit`;--> statement-breakpoint
CREATE INDEX `audit_target_ix` ON `audit` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_creation_ix` ON `audit` (`creation`);--> statement-breakpoint
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
