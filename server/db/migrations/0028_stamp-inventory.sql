-- The stamp columns (db/schema/stamps.ts) on servers, clusters, apps, tenants and tenant_apps, and the
-- deletion columns on servers and tenant_apps, by table rebuilds: SQLite refuses an added NOT NULL
-- column without a default on a table that holds rows. `tenants.owner` held the GitHub owner of the
-- tenant's repositories and becomes `repo_owner`, so `owner` names who added the row, as on every table.
-- Every row is carried with the times and actors it recorded:
--   servers      creation = created_at; modified is the last recorded time; owner is the actor of its
--                `server.created` or `server.master_seeded` audit row.
--   clusters     creation is the time of its `cluster.master_seeded` audit row, else provisioned_at, the
--                earliest time recorded for a slave's cluster; owner is that audit row's actor.
--   apps         creation = created_at, modified = updated_at.
--   tenants      creation = created_at, modified = updated_at.
--   tenant_apps  creation = modified = created_at.
-- A deleted server or tenant app left no row, so none is carried as deleted. A time nothing recorded is
-- the migration's, and an actor nothing recorded is `unrecorded`.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_servers` (
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
	`adopted_at` integer,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text
);
--> statement-breakpoint
INSERT INTO `__new_servers`("id", "name", "host", "lan_host", "tailnet_host", "ssh_port", "ssh_user", "role", "status", "machine_id", "preflight_json", "tailnet_state", "tailnet_json", "password_login_state", "password_login_json", "authorized_keys_state", "authorized_keys_json", "notes", "adopted_at", "creation", "modified", "owner", "modified_by", "deleted", "deleted_by")
SELECT s."id", s."name", s."host", s."lan_host", s."tailnet_host", s."ssh_port", s."ssh_user", s."role", s."status", s."machine_id", s."preflight_json", s."tailnet_state", s."tailnet_json", s."password_login_state", s."password_login_json", s."authorized_keys_state", s."authorized_keys_json", s."notes", s."adopted_at",
	s."created_at",
	max(s."created_at", coalesce(s."adopted_at", 0)),
	coalesce((SELECT a."owner" FROM `audit` a WHERE a."target_kind" = 'server' AND a."target_id" = s."id" AND a."action" IN ('server.created', 'server.master_seeded') ORDER BY a."creation", a."id" LIMIT 1), 'unrecorded'),
	'unrecorded',
	NULL,
	NULL
FROM `servers` s;--> statement-breakpoint
DROP TABLE `servers`;--> statement-breakpoint
ALTER TABLE `__new_servers` RENAME TO `servers`;--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_uq` ON `servers` (`name`) WHERE deleted IS NULL;;--> statement-breakpoint
CREATE UNIQUE INDEX `servers_host_port_uq` ON `servers` (`host`,`ssh_port`) WHERE deleted IS NULL;;--> statement-breakpoint
CREATE UNIQUE INDEX `servers_one_master_uq` ON `servers` ((role = 'master')) WHERE role = 'master' AND deleted IS NULL;;--> statement-breakpoint
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
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_clusters`("id", "server_id", "stage", "domain", "name", "status", "slave_id", "plane_state", "plane_json", "provisioned_at", "creation", "modified", "owner", "modified_by")
SELECT c."id", c."server_id", c."stage", c."domain", c."name", c."status", c."slave_id", c."plane_state", c."plane_json", c."provisioned_at",
	c."seeded",
	max(c."seeded", coalesce(c."provisioned_at", 0)),
	coalesce((SELECT a."owner" FROM `audit` a WHERE a."target_kind" = 'cluster' AND a."target_id" = c."id" AND a."action" = 'cluster.master_seeded' ORDER BY a."creation", a."id" LIMIT 1), 'unrecorded'),
	'unrecorded'
FROM (SELECT k.*, coalesce((SELECT a."creation" FROM `audit` a WHERE a."target_kind" = 'cluster' AND a."target_id" = k."id" AND a."action" = 'cluster.master_seeded' ORDER BY a."creation", a."id" LIMIT 1), k."provisioned_at", (unixepoch('subsec') * 1000)) AS "seeded" FROM `clusters` k) c;--> statement-breakpoint
DROP TABLE `clusters`;--> statement-breakpoint
ALTER TABLE `__new_clusters` RENAME TO `clusters`;--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_server_uq` ON `clusters` (`server_id`);;--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_domain_uq` ON `clusters` (`domain`);;--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_name_uq` ON `clusters` (`name`);;--> statement-breakpoint
CREATE UNIQUE INDEX `clusters_slave_id_uq` ON `clusters` (`slave_id`) WHERE slave_id IS NOT NULL;;--> statement-breakpoint
CREATE TABLE `__new_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`host` text NOT NULL,
	`repo_url` text,
	`chart_path` text,
	`provenance` text DEFAULT 'manager' NOT NULL,
	`last_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`check_json` text,
	`dkim_public_key` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `clusters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_apps`("id", "cluster_id", "name", "stage", "host", "repo_url", "chart_path", "provenance", "last_run_id", "status", "check_json", "dkim_public_key", "creation", "modified", "owner", "modified_by")
SELECT p."id", p."cluster_id", p."name", p."stage", p."host", p."repo_url", p."chart_path", p."provenance", p."last_run_id", p."status", p."check_json", p."dkim_public_key",
	p."created_at",
	p."updated_at",
	'unrecorded',
	'unrecorded'
FROM `apps` p;--> statement-breakpoint
DROP TABLE `apps`;--> statement-breakpoint
ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_name_stage_uq` ON `apps` (`name`,`stage`);;--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`guid` text NOT NULL,
	`subdomain` text NOT NULL,
	`stage` text NOT NULL,
	`identity_provider` text NOT NULL,
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
INSERT INTO `__new_tenants`("id", "cluster_id", "guid", "subdomain", "stage", "identity_provider", "members", "own_domain", "own_domain_redirects", "own_domain_aliases", "approved_tags", "sender_domain", "display_name", "size", "seed_users", "suspended", "follow_releases", "nests_under", "repo_owner", "provenance", "last_run_id", "status", "admin_state", "admin_count", "admin_checked_at", "check_json", "creation", "modified", "owner", "modified_by")
SELECT t."id", t."cluster_id", t."guid", t."subdomain", t."stage", t."identity_provider", t."members", t."own_domain", t."own_domain_redirects", t."own_domain_aliases", t."approved_tags", t."sender_domain", t."display_name", t."size", t."seed_users", t."suspended", t."follow_releases", t."nests_under",
	t."owner",
	t."provenance",
	t."last_run_id",
	t."status",
	t."admin_state",
	t."admin_count",
	t."admin_checked_at",
	t."check_json",
	t."created_at",
	t."updated_at",
	'unrecorded',
	'unrecorded'
FROM `tenants` t;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_guid_stage_uq` ON `tenants` (`guid`,`stage`);;--> statement-breakpoint
CREATE TABLE `__new_tenant_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_run_id` text,
	`site` text,
	`creation` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`modified` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`owner` text NOT NULL,
	`modified_by` text NOT NULL,
	`deleted` integer,
	`deleted_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_tenant_apps`("id", "tenant_id", "name", "status", "last_run_id", "site", "creation", "modified", "owner", "modified_by", "deleted", "deleted_by")
SELECT ta."id", ta."tenant_id", ta."name", ta."status", ta."last_run_id", ta."site",
	ta."created_at",
	ta."created_at",
	'unrecorded',
	'unrecorded',
	NULL,
	NULL
FROM `tenant_apps` ta;--> statement-breakpoint
DROP TABLE `tenant_apps`;--> statement-breakpoint
ALTER TABLE `__new_tenant_apps` RENAME TO `tenant_apps`;--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_apps_tenant_name_uq` ON `tenant_apps` (`tenant_id`,`name`) WHERE deleted IS NULL;;--> statement-breakpoint
PRAGMA foreign_keys=ON;
