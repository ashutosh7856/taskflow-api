CREATE TYPE "public"."priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "priority" "priority" DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "estimate_minutes" integer;