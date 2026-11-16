CREATE INDEX `users_created_idx` ON `users` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_logs_board_idx` ON `activity_logs` (`board_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_logs_card_idx` ON `activity_logs` (`card_id`);--> statement-breakpoint
CREATE INDEX `board_members_user_idx` ON `board_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `boards_workspace_idx` ON `boards` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `card_files_board_idx` ON `card_files` (`board_id`);--> statement-breakpoint
CREATE INDEX `card_labels_label_idx` ON `card_labels` (`label_id`);--> statement-breakpoint
CREATE INDEX `card_members_user_idx` ON `card_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `checklist_items_checklist_idx` ON `checklist_items` (`checklist_id`,`position`);--> statement-breakpoint
CREATE INDEX `checklists_card_idx` ON `checklists` (`card_id`);--> statement-breakpoint
CREATE INDEX `client_feedback_card_idx` ON `client_feedback` (`card_id`);--> statement-breakpoint
CREATE INDEX `comments_card_idx` ON `comments` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `invites_workspace_idx` ON `invites` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `invites_board_idx` ON `invites` (`board_id`);--> statement-breakpoint
CREATE INDEX `labels_board_idx` ON `labels` (`board_id`);--> statement-breakpoint
CREATE INDEX `payment_event_subscription_idx` ON `payment_events` (`provider_subscription_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspaces_owner_idx` ON `workspaces` (`owner_id`);