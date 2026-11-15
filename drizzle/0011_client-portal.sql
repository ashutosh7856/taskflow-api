CREATE TYPE "public"."approval_status" AS ENUM('none', 'pending', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."client_feedback_kind" AS ENUM('comment', 'approved', 'changes_requested', 'request');--> statement-breakpoint
CREATE TABLE "client_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" uuid,
	"kind" "client_feedback_kind" NOT NULL,
	"author_name" text NOT NULL,
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_token" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_client_name" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_client_email" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_welcome" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "portal_allow_requests" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "client_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "approval_status" "approval_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "approval_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "approval_responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_logo_url" text;--> statement-breakpoint
ALTER TABLE "client_feedback" ADD CONSTRAINT "client_feedback_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_feedback" ADD CONSTRAINT "client_feedback_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_feedback_board_created_idx" ON "client_feedback" USING btree ("board_id","created_at");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_portal_token_unique" UNIQUE("portal_token");