CREATE TABLE "subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"billing_status" "billing_status" DEFAULT 'inactive' NOT NULL,
	"paypal_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"ai_requests_this_month" integer DEFAULT 0 NOT NULL,
	"ai_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_paypal_subscription_id_unique" UNIQUE("paypal_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_paypal_subscription_id_unique";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "plan";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "billing_status";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "paypal_subscription_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "current_period_end";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ai_requests_this_month";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ai_period_start";