-- HAND-EDITED after `npm run db:generate`, by the owner's decision on #264 (Q-A): `IF NOT EXISTS` is added
-- to the CREATE TABLE drizzle-kit wrote, and nothing else. drizzle-kit 0.31.10 cannot write it itself.
-- unit_sizes was created by the core's baseline and carries the sizes an installation sells; this first
-- migration of the unit plugin ADOPTS it: it creates the table only where none stands, and leaves a
-- standing one and its rows untouched. The snapshot beside it is as generated, so the next generate
-- diffs the plugin's schema against this table.
CREATE TABLE IF NOT EXISTS `unit_sizes` (
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
