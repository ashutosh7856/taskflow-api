CREATE TABLE `admin_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text,
	`action` text NOT NULL,
	`target_user_id` text,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `admin_audit_created_idx` ON `admin_audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `admin_login_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`request_ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_login_codes_created_idx` ON `admin_login_codes` (`created_at`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `password_resets_user_idx` ON `password_resets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`password_changed_at` integer,
	`last_seen_at` integer,
	`suspended_at` integer,
	`signup_source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`board_id` text NOT NULL,
	`card_id` text,
	`action` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`feature` text NOT NULL,
	`input_characters` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_microusd` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_usage_user_created_idx` ON `ai_usage_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `annual_billing_plans` (
	`plan` text PRIMARY KEY NOT NULL,
	`paypal_product_id` text NOT NULL,
	`paypal_plan_id` text NOT NULL,
	`price_usd` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annual_billing_plans_paypal_plan_id_unique` ON `annual_billing_plans` (`paypal_plan_id`);--> statement-breakpoint
CREATE TABLE `billing_plans` (
	`plan` text PRIMARY KEY NOT NULL,
	`paypal_product_id` text NOT NULL,
	`paypal_plan_id` text NOT NULL,
	`price_usd` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_plans_paypal_plan_id_unique` ON `billing_plans` (`paypal_plan_id`);--> statement-breakpoint
CREATE TABLE `board_members` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_user_unique_idx` ON `board_members` (`board_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`background_color` text DEFAULT 'blue' NOT NULL,
	`template` text DEFAULT 'blank' NOT NULL,
	`portal_token` text,
	`portal_enabled` integer DEFAULT false NOT NULL,
	`portal_client_name` text,
	`portal_client_email` text,
	`portal_welcome` text,
	`portal_allow_requests` integer DEFAULT true NOT NULL,
	`portal_weekly_updates` integer DEFAULT false NOT NULL,
	`portal_last_auto_update_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_portal_token_unique` ON `boards` (`portal_token`);--> statement-breakpoint
CREATE TABLE `card_files` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`board_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`uploaded_by` text,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_files_storage_key_unique` ON `card_files` (`storage_key`);--> statement-breakpoint
CREATE INDEX `card_files_card_idx` ON `card_files` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `card_files_workspace_idx` ON `card_files` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `card_labels` (
	`card_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`card_id`, `label_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_members` (
	`card_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`card_id`, `user_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`is_completed` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`category` text DEFAULT 'task' NOT NULL,
	`due_date` integer,
	`priority` text DEFAULT 'medium' NOT NULL,
	`estimate_minutes` integer,
	`client_visible` integer DEFAULT true NOT NULL,
	`approval_status` text DEFAULT 'none' NOT NULL,
	`approval_requested_at` integer,
	`approval_responded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cards_list_position_idx` ON `cards` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`checklist_id` text NOT NULL,
	`title` text NOT NULL,
	`is_done` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`checklist_id`) REFERENCES `checklists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `checklists` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `client_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`card_id` text,
	`kind` text NOT NULL,
	`author_name` text NOT NULL,
	`message` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `client_feedback_board_created_idx` ON `client_feedback` (`board_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `discount_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`percent_off` integer NOT NULL,
	`discount_plan` text,
	`max_redemptions` integer,
	`redemption_count` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`starts_at` integer,
	`expires_at` integer,
	`paypal_pro_plan_id` text,
	`paypal_business_plan_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_codes_code_unique` ON `discount_codes` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `discount_codes_paypal_pro_plan_id_unique` ON `discount_codes` (`paypal_pro_plan_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `discount_codes_paypal_business_plan_id_unique` ON `discount_codes` (`paypal_business_plan_id`);--> statement-breakpoint
CREATE INDEX `discount_code_active_idx` ON `discount_codes` (`active`,`code`);--> statement-breakpoint
CREATE TABLE `discount_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_code_id` text NOT NULL,
	`user_id` text NOT NULL,
	`plan` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`discount_code_id`) REFERENCES `discount_codes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_redemption_code_user_idx` ON `discount_redemptions` (`discount_code_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`email` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`board_id` text,
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lists_board_position_idx` ON `lists` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`provider_subscription_id` text,
	`user_id` text,
	`plan` text,
	`status` text NOT NULL,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_event_id_unique` ON `payment_events` (`provider_event_id`);--> statement-breakpoint
CREATE INDEX `payment_event_occurred_idx` ON `payment_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `payment_event_user_idx` ON `payment_events` (`user_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`billing_status` text DEFAULT 'inactive' NOT NULL,
	`paypal_subscription_id` text,
	`billing_interval` text DEFAULT 'month' NOT NULL,
	`discount_code_id` text,
	`current_period_end` integer,
	`ai_requests_this_month` integer DEFAULT 0 NOT NULL,
	`ai_period_start` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_paypal_subscription_id_unique` ON `subscriptions` (`paypal_subscription_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_user_unique_idx` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brand_name` text,
	`brand_color` text,
	`brand_logo_url` text,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
