-- clusters.name: the cluster's name, fixed at its adoption — the cluster map's global.clusterName —
-- after which its per-slave plane, its Vault mount, its tailnet user and every registration's
-- `cluster` are named. A rename moves `domain` and leaves the name. Added by a table rebuild and not
-- by ADD COLUMN: SQLite refuses a NOT NULL column without a default on a table that holds rows (the
-- #229 shape, see 0002). A carried row's name is the first label of its domain, which is what its
-- map's clusterName was written from.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`stage` text NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`slave_id` integer,
	`plane_state` text DEFAULT 'absent' NOT NULL,
	`plane_json` text,
	`provisioned_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_clusters`("id", "server_id", "stage", "domain", "name", "status", "slave_id", "plane_state", "plane_json", "provisioned_at")
SELECT "id", "server_id", "stage", "domain", CASE WHEN instr("domain", '.') > 0 THEN substr("domain", 1, instr("domain", '.') - 1) ELSE "domain" END, "status", "slave_id", "plane_state", "plane_json", "provisioned_at" FROM `clusters`;--> statement-breakpoint
DROP TABLE `clusters`;--> statement-breakpoint
ALTER TABLE `__new_clusters` RENAME TO `clusters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_server_uq` ON `clusters` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_domain_uq` ON `clusters` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_name_uq` ON `clusters` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_slave_id_uq` ON `clusters` (`slave_id`) WHERE slave_id IS NOT NULL;
