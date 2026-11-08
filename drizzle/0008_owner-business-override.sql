UPDATE "subscriptions" AS "s"
SET
  "plan" = 'business',
  "billing_status" = 'active',
  "paypal_subscription_id" = NULL,
  "current_period_end" = NULL,
  "ai_requests_this_month" = 0,
  "ai_period_start" = NOW(),
  "updated_at" = NOW()
FROM "users" AS "u"
WHERE "s"."user_id" = "u"."id"
  AND LOWER("u"."email") = LOWER('apped.v@gmail.com');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "users" AS "u"
    INNER JOIN "subscriptions" AS "s" ON "s"."user_id" = "u"."id"
    WHERE LOWER("u"."email") = LOWER('apped.v@gmail.com')
      AND "s"."plan" = 'business'
      AND "s"."billing_status" = 'active'
      AND "s"."paypal_subscription_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Manual Business override verification failed for the owner account';
  END IF;
END
$$;
