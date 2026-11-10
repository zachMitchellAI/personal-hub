CREATE TABLE `task_trello` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`created_at` text NOT NULL,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_trello_card_unique` ON `task_trello` (`card_id`);