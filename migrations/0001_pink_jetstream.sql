ALTER TABLE `repositories` ADD `provider` text DEFAULT 'gitlab';--> statement-breakpoint
ALTER TABLE `repositories` ADD `remote_id` text;