CREATE TABLE `contact_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`primary_flag` integer DEFAULT 0 NOT NULL,
	`source` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
