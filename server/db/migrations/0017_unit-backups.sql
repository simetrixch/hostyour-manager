CREATE TABLE `unit_backups` (
	`kind` text NOT NULL,
	`unit` text NOT NULL,
	`stage` text NOT NULL,
	`generation` text NOT NULL,
	`folder` text NOT NULL,
	`trigger` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`detail` text,
	`taken_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`kind`, `unit`, `stage`, `generation`)
);
