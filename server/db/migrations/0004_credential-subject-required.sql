DROP TABLE `organisation_identities`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`purpose` text NOT NULL,
	`encrypted_blob` text NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	`rotated_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_credentials`("id", "kind", "label", "subject_kind", "subject_id", "purpose", "encrypted_blob", "fingerprint", "public_key", "created_at", "last_used_at", "rotated_at", "revoked_at") SELECT "id", "kind", "label", "subject_kind", "subject_id", "purpose", "encrypted_blob", "fingerprint", "public_key", "created_at", "last_used_at", "rotated_at", "revoked_at" FROM `credentials`;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `credentials_subject_ix` ON `credentials` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `credentials_fingerprint_ix` ON `credentials` (`fingerprint`);