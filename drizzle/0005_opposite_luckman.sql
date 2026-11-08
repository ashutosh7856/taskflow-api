ALTER TABLE "boards" ADD COLUMN "template" text DEFAULT 'blank' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "is_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "category" text DEFAULT 'task' NOT NULL;