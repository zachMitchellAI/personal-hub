CREATE TABLE `trackable_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trackable_id` integer NOT NULL,
	`event_date` text NOT NULL,
	`event_type` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`trackable_id`) REFERENCES `trackables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trackables` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`party` text,
	`stage` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "trackables_status_check" CHECK("trackables"."status" in ('active', 'closed'))
);
