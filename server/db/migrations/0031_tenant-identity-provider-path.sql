-- HAND-WRITTEN: tenants gains `identity_provider_path`, the path the tenant's identity provider serves on
-- the tenant's host, by a table rebuild: SQLite refuses an added NOT NULL column without a default on a
-- table that holds rows, and a default would stand in for a path nobody declared. Every row is carried
-- with the path the Manager addressed its identity provider at until now, `/` and the member's name.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`guid` text NOT NULL,
	`subdomain` text NOT NULL,
	`stage` text NOT NULL,
	`identity_provider` text NOT NULL,
	`identity_provider_path` text NOT NULL,
	`members` text NOT NULL,
	`own_domain` text DEFAULT '' NOT NULL,
	`own_domain_redirects` text DEFAULT '[]' NOT NULL,
	`own_domain_aliases` text DEFAULT '[]' NOT NULL,
	`approved_tags` text DEFAULT '{}' NOT NULL,
	`sender_domain` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`size` text,
	`seed_users` integer DEFAULT false NOT NULL,
	`suspended` integer DEFAULT false NOT NULL,
	`follow_releases` integer DEFAULT false NOT NULL,
	`nests_under` text,
	`repo_owner` text,
	`provenance` text DEFAULT 'manager' NOT NULL,
	`last_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`admin_state` text,
	`admin_count` integer,
	`admin_checked_at` integer,
	`check_json` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_tenants`("id", "cluster_id", "guid", "subdomain", "stage", "identity_provider", "identity_provider_path", "members", "own_domain", "own_domain_redirects", "own_domain_aliases", "approved_tags", "sender_domain", "display_name", "size", "seed_users", "suspended", "follow_releases", "nests_under", "repo_owner", "provenance", "last_run_id", "status", "admin_state", "admin_count", "admin_checked_at", "check_json", "creation", "modified", "owner", "modified_by") SELECT "id", "cluster_id", "guid", "subdomain", "stage", "identity_provider", '/' || "identity_provider", "members", "own_domain", "own_domain_redirects", "own_domain_aliases", "approved_tags", "sender_domain", "display_name", "size", "seed_users", "suspended", "follow_releases", "nests_under", "repo_owner", "provenance", "last_run_id", "status", "admin_state", "admin_count", "admin_checked_at", "check_json", "creation", "modified", "owner", "modified_by" FROM `tenants`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_guid_stage_uq` ON `tenants` (`guid`,`stage`);
