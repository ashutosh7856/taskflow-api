CREATE TYPE "public"."billing_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TABLE "annual_billing_plans" (
	"plan" "plan" PRIMARY KEY NOT NULL,
	"paypal_product_id" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"price_usd" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annual_billing_plans_paypal_plan_id_unique" UNIQUE("paypal_plan_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" "billing_interval" DEFAULT 'month' NOT NULL;