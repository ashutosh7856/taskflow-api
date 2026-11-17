ALTER TABLE `discount_codes` ADD `dodo_discount_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `dodo_subscription_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `dodo_customer_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_dodo_subscription_id_unique` ON `subscriptions` (`dodo_subscription_id`);