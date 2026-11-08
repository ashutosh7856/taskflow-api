DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "users" AS "u"
    INNER JOIN "subscriptions" AS "s" ON "s"."user_id" = "u"."id"
    WHERE LOWER("u"."email") = LOWER('apped.v@gmail.com')
      AND "s"."plan" = 'business'
      AND "s"."billing_status" = 'active'
  ) THEN
    RAISE EXCEPTION 'Business plan grant verification failed for the requested owner account';
  END IF;
END
$$;
