INSERT INTO "subscriptions" (
  "user_id",
  "plan",
  "billing_status",
  "ai_requests_this_month",
  "ai_period_start",
  "updated_at"
)
SELECT
  "id",
  'business',
  'active',
  0,
  NOW(),
  NOW()
FROM "users"
WHERE LOWER("email") = LOWER('apped.v@gmail.com')
ON CONFLICT ("user_id") DO UPDATE
SET
  "plan" = 'business',
  "billing_status" = 'active',
  "updated_at" = NOW();
