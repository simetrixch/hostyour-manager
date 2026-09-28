CREATE TABLE `secret_writes` (
	`entry` text NOT NULL,
	`key` text NOT NULL,
	`act` text NOT NULL,
	`run_id` text NOT NULL,
	`written_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`entry`, `key`)
);
