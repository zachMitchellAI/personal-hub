CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`relationship_type` text,
	`employer` text,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_slug_unique` ON `people` (`slug`);