CREATE TYPE "public"."billing_status" AS ENUM('inactive', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'pro', 'business');--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"plan" "plan" PRIMARY KEY NOT NULL,
	"paypal_product_id" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"price_usd" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_paypal_plan_id_unique" UNIQUE("paypal_plan_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" "plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_status" "billing_status" DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "paypal_subscription_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_requests_this_month" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_period_start" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_paypal_subscription_id_unique" UNIQUE("paypal_subscription_id");