CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active',
	`created_by` text,
	`created_at` text
);
--> statement-breakpoint
CREATE TABLE `release_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`content` text,
	`generated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_name_unique` ON `releases` (`name`);
