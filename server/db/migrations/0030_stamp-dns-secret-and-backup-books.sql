-- The stamp columns (db/schema/stamps.ts) on dns_writes, secret_writes and unit_backups, and the
-- deletion columns on dns_writes and secret_writes, by table rebuilds. Every row is carried with the
-- times and actors it recorded:
--   dns_writes     the book kept only the latest write of a record, so the carried row starts at that
--   secret_writes  write: creation = modified = written_at, and owner = modified_by = the owner of its
--                  run, the operator the run executed as. The id is the row's rowid in the shape of a
--                  minted id, so it sorts before every later one.
--   unit_backups   creation = taken_at, modified = finished_at where the generation finished; owner =
--                  modified_by = the owner of its run. A pruned generation was changed later, by an
--                  actor nothing recorded; its modified stays the last time recorded.
-- An actor nothing recorded is `unrecorded`.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dns_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`act` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_name` text NOT NULL,
	`owner_stage` text,
	`run_id` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text
);
--> statement-breakpoint
INSERT INTO `__new_dns_writes`("id", "name", "type", "content", "act", "owner_kind", "owner_name", "owner_stage", "run_id", "creation", "modified", "owner", "modified_by")
SELECT 'dnsw_' || printf('%026d', d.rowid), d."name", d."type", d."content", d."act", d."owner_kind", d."owner_name", d."owner_stage", d."run_id", d."written_at", d."written_at",
	coalesce(r."owner", 'unrecorded'), coalesce(r."owner", 'unrecorded')
FROM `dns_writes` d LEFT JOIN `runs` r ON r."id" = d."run_id";--> statement-breakpoint
DROP TABLE `dns_writes`;--> statement-breakpoint
ALTER TABLE `__new_dns_writes` RENAME TO `dns_writes`;--> statement-breakpoint
CREATE UNIQUE INDEX `dns_writes_record_uq` ON `dns_writes` (`name`,`type`) WHERE deleted IS NULL;--> statement-breakpoint
CREATE TABLE `__new_secret_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`entry` text NOT NULL,
	`key` text NOT NULL,
	`act` text NOT NULL,
	`run_id` text NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text
);
--> statement-breakpoint
INSERT INTO `__new_secret_writes`("id", "entry", "key", "act", "run_id", "creation", "modified", "owner", "modified_by")
SELECT 'secw_' || printf('%026d', s.rowid), s."entry", s."key", s."act", s."run_id", s."written_at", s."written_at",
	coalesce(r."owner", 'unrecorded'), coalesce(r."owner", 'unrecorded')
FROM `secret_writes` s LEFT JOIN `runs` r ON r."id" = s."run_id";--> statement-breakpoint
DROP TABLE `secret_writes`;--> statement-breakpoint
ALTER TABLE `__new_secret_writes` RENAME TO `secret_writes`;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_writes_key_uq` ON `secret_writes` (`entry`,`key`) WHERE deleted IS NULL;--> statement-breakpoint
CREATE TABLE `__new_unit_backups` (
	`kind` text NOT NULL,
	`unit` text NOT NULL,
	`stage` text NOT NULL,
	`generation` text NOT NULL,
	`folder` text NOT NULL,
	`trigger` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`detail` text,
	`taken_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	PRIMARY KEY(`kind`, `unit`, `stage`, `generation`)
);
--> statement-breakpoint
INSERT INTO `__new_unit_backups`("kind", "unit", "stage", "generation", "folder", "trigger", "run_id", "state", "detail", "taken_at", "finished_at", "creation", "modified", "owner", "modified_by")
SELECT b."kind", b."unit", b."stage", b."generation", b."folder", b."trigger", b."run_id", b."state", b."detail", b."taken_at", b."finished_at", b."taken_at", coalesce(b."finished_at", b."taken_at"),
	coalesce(r."owner", 'unrecorded'), CASE WHEN b."state" = 'pruned' THEN 'unrecorded' ELSE coalesce(r."owner", 'unrecorded') END
FROM `unit_backups` b LEFT JOIN `runs` r ON r."id" = b."run_id";--> statement-breakpoint
DROP TABLE `unit_backups`;--> statement-breakpoint
ALTER TABLE `__new_unit_backups` RENAME TO `unit_backups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
