CREATE TABLE `user_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`page` text,
	`status` text DEFAULT 'new' NOT NULL,
	`ai` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_feedback_created_idx` ON `user_feedback` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_feedback_user_idx` ON `user_feedback` (`user_id`);