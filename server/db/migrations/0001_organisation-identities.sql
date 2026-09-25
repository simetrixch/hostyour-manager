CREATE TABLE `organisation_identities` (
	`org` text PRIMARY KEY NOT NULL,
	`packages_credential_id` text,
	`repo_credential_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
