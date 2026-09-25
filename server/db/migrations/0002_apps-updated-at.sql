-- apps.updated_at (hostyour-manager#224), added by a table rebuild and not by ADD COLUMN: SQLite
-- refuses a non-constant default on a column added to a table that holds rows ("Cannot add a column
-- with non-constant default"), which is what killed the Manager on the first standing installation
-- (#229). A carried row's updated_at is its created_at — the last time anything wrote it.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`host` text NOT NULL,
	`repo_url` text,
	`chart_path` text,
	`repo_credential_id` text,
	`provenance` text DEFAULT 'manager' NOT NULL,
	`last_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`check_json` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_apps`("id", "cluster_id", "name", "stage", "host", "repo_url", "chart_path", "repo_credential_id", "provenance", "last_run_id", "status", "check_json", "created_at", "updated_at")
SELECT "id", "cluster_id", "name", "stage", "host", "repo_url", "chart_path", "repo_credential_id", "provenance", "last_run_id", "status", "check_json", "created_at", "created_at" FROM `apps`;--> statement-breakpoint
DROP TABLE `apps`;--> statement-breakpoint
ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_name_stage_uq` ON `apps` (`name`,`stage`);
