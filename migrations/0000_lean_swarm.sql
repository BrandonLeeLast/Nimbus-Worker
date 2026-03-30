CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active',
	`created_by` text,
	`created_at` text
);
--> statement-breakpoint
CREATE TABLE `cleanup_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`executed_at` text,
	`branches_deleted` integer
);
--> statement-breakpoint
CREATE TABLE `hotfixes` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text,
	`pr_url` text,
	`author` text,
	`developer` text,
	`ticket_id` text,
	`merged_at` text
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL
);
