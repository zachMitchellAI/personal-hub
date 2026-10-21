CREATE TABLE `subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`label` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`person_id` integer,
	`context` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`due_date` text,
	`completed_at` text,
	`origin` text DEFAULT 'self' NOT NULL,
	`notes` text,
	`trello_visible` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('ready', 'in-progress', 'completed'))
);
