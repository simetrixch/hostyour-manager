-- HAND-WRITTEN over `npm run db:generate:unit`: the stamp columns (#core/server/db/schema/stamps.ts) on
-- unit_sizes, by a table rebuild, because SQLite refuses an added NOT NULL column without a default
-- on a table that holds rows. Every row is carried: updated_at is the earliest time a row recorded, so
-- creation = modified = updated_at. Nothing recorded who seeded or changed a size: `unrecorded`.
CREATE TABLE `__new_unit_sizes` (
	`component` text NOT NULL,
	`name` text NOT NULL,
	`requests_cpu` text NOT NULL,
	`requests_memory` text NOT NULL,
	`limits_cpu` text NOT NULL,
	`limits_memory` text NOT NULL,
	`pods` integer NOT NULL,
	`persistent_volume_claims` integer NOT NULL,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	PRIMARY KEY(`component`, `name`)
);
--> statement-breakpoint
INSERT INTO `__new_unit_sizes`("component", "name", "requests_cpu", "requests_memory", "limits_cpu", "limits_memory", "pods", "persistent_volume_claims", "creation", "modified", "owner", "modified_by")
SELECT "component", "name", "requests_cpu", "requests_memory", "limits_cpu", "limits_memory", "pods", "persistent_volume_claims", "updated_at", "updated_at", 'unrecorded', 'unrecorded' FROM `unit_sizes`;--> statement-breakpoint
DROP TABLE `unit_sizes`;--> statement-breakpoint
ALTER TABLE `__new_unit_sizes` RENAME TO `unit_sizes`;
