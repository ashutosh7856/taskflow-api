CREATE TABLE `subscription_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`provider_subscription_id` text,
	`kind` text NOT NULL,
	`plan` text,
	`billing_interval` text,
	`trial` integer DEFAULT false NOT NULL,
	`mrr_before_cents` integer DEFAULT 0 NOT NULL,
	`mrr_after_cents` integer DEFAULT 0 NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `subscription_event_occurred_idx` ON `subscription_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `subscription_event_user_idx` ON `subscription_events` (`user_id`);