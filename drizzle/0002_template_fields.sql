ALTER TABLE `cards` ADD `fields` text;--> statement-breakpoint
ALTER TABLE `lists` ADD `role` text;--> statement-breakpoint
-- Give existing boards' lists roles by name so completion and approval
-- automation works on boards created before templates had roles.
UPDATE `lists` SET `role` = 'done' WHERE lower(`name`) IN ('done', 'published', 'resolved', 'delivered', 'live', 'shipped', 'launched');--> statement-breakpoint
UPDATE `lists` SET `role` = 'review' WHERE lower(`name`) IN ('ready for review', 'review', 'approval', 'client review', 'client approval');--> statement-breakpoint
UPDATE `lists` SET `role` = 'intake' WHERE lower(`name`) IN ('requests', 'backlog', 'ideas');
