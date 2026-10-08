CREATE TABLE `revoked_sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
