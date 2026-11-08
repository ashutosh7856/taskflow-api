import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { billingPlans, subscriptions } from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import { paypalConfigured, paypalRequest } from "../services/paypal";
import { planCatalog } from "../services/entitlements";

const billingRouter = new Hono<AppEnv>();
const paidPlanSchema = z.enum(["pro", "business"]);

async function accountSubscription(ownerId: string) {
  let subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, ownerId),
  });
  if (!subscription)
    [subscription] = await db
      .insert(subscriptions)
      .values({ userId: ownerId })
      .returning();
  return subscription;
}

billingRouter.get("/billing", async (c) => {
  const subscription = await accountSubscription(c.get("userId"));
  const plans = await db
    .select()
    .from(billingPlans)
    .where(eq(billingPlans.active, true));
  return c.json({
    plan: subscription.plan,
    billingStatus: subscription.billingStatus,
    currentPeriodEnd: subscription.currentPeriodEnd,
    aiRequestsThisMonth: subscription.aiRequestsThisMonth,
    aiPeriodStart: subscription.aiPeriodStart,
    paypalSubscriptionId: subscription.paypalSubscriptionId,
    entitlements: planCatalog[subscription.plan],
    paypal: {
      configured: paypalConfigured(),
      clientId: process.env.PAYPAL_CLIENT_ID || null,
      environment: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
    },
    plans: plans.map((plan) => ({
      plan: plan.plan,
      priceUsd: plan.priceUsd,
      paypalPlanId: plan.paypalPlanId,
    })),
  });
});

billingRouter.post("/billing/paypal/setup", async (c) => {
  const userId = c.get("userId");
  const { plan } = await body(c, z.object({ plan: paidPlanSchema }));
  const existing = await db.query.billingPlans.findFirst({
    where: eq(billingPlans.plan, plan),
  });
  if (existing)
    return c.json({
      plan,
      priceUsd: existing.priceUsd,
      paypalPlanId: existing.paypalPlanId,
    });
  const priceUsd = planCatalog[plan].priceUsd;
  const product = await paypalRequest<{ id: string }>("/v1/catalogs/products", {
    method: "POST",
    headers: { "PayPal-Request-Id": `taskflow-${plan}-account-product-v2` },
    body: JSON.stringify({
      name: `TaskFlow ${plan === "pro" ? "Pro" : "Business"}`,
      description:
        "TaskFlow account subscription covering all owned workspaces",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  const paypalPlan = await paypalRequest<{ id: string }>("/v1/billing/plans", {
    method: "POST",
    headers: { "PayPal-Request-Id": `taskflow-${plan}-account-monthly-v2` },
    body: JSON.stringify({
      product_id: product.id,
      name: `TaskFlow ${plan === "pro" ? "Pro" : "Business"} monthly`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: priceUsd.toFixed(2), currency_code: "USD" },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 2,
      },
    }),
  });
  const [created] = await db
    .insert(billingPlans)
    .values({
      plan,
      paypalProductId: product.id,
      paypalPlanId: paypalPlan.id,
      priceUsd,
    })
    .returning();
  return c.json(
    { plan, priceUsd: created.priceUsd, paypalPlanId: created.paypalPlanId },
    201,
  );
});

billingRouter.post("/billing/paypal/activate", async (c) => {
  const userId = c.get("userId");
  const { subscriptionId } = await body(
    c,
    z.object({ subscriptionId: z.string().min(3).max(100) }),
  );
  const paypalSubscription = await paypalRequest<any>(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  if (paypalSubscription.status !== "ACTIVE")
    throw new HttpError(409, "The PayPal subscription is not active yet");
  if (paypalSubscription.custom_id && paypalSubscription.custom_id !== userId)
    throw new HttpError(400, "Subscription account mismatch");
  const plan = await db.query.billingPlans.findFirst({
    where: eq(billingPlans.paypalPlanId, paypalSubscription.plan_id),
  });
  if (!plan || plan.plan === "free")
    throw new HttpError(400, "Unknown PayPal plan");
  const [subscription] = await db
    .update(subscriptions)
    .set({
      plan: plan.plan,
      billingStatus: "active",
      paypalSubscriptionId: subscriptionId,
      currentPeriodEnd: paypalSubscription.billing_info?.next_billing_time
        ? new Date(paypalSubscription.billing_info.next_billing_time)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId))
    .returning();
  return c.json(subscription);
});

billingRouter.post("/billing/cancel", async (c) => {
  const userId = c.get("userId");
  const subscription = await accountSubscription(userId);
  if (!subscription.paypalSubscriptionId)
    throw new HttpError(409, "No active subscription found");
  await paypalRequest(
    `/v1/billing/subscriptions/${encodeURIComponent(subscription.paypalSubscriptionId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ reason: "Cancelled by account owner" }),
    },
  );
  await db
    .update(subscriptions)
    .set({ billingStatus: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.userId, userId));
  return c.json({ cancelled: true });
});

export const paypalWebhook = new Hono();
paypalWebhook.post("/paypal", async (c) => {
  const event = await c.req.json();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new HttpError(503, "PayPal webhook is not configured");
  const verification = await paypalRequest<{ verification_status: string }>(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        auth_algo: c.req.header("paypal-auth-algo"),
        cert_url: c.req.header("paypal-cert-url"),
        transmission_id: c.req.header("paypal-transmission-id"),
        transmission_sig: c.req.header("paypal-transmission-sig"),
        transmission_time: c.req.header("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      }),
    },
  );
  if (verification.verification_status !== "SUCCESS")
    throw new HttpError(400, "Invalid PayPal webhook signature");
  const subscriptionId = event.resource?.id;
  if (subscriptionId) {
    const statusMap: Record<string, "active" | "past_due" | "cancelled"> = {
      "BILLING.SUBSCRIPTION.ACTIVATED": "active",
      "BILLING.SUBSCRIPTION.SUSPENDED": "past_due",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "past_due",
      "BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
      "BILLING.SUBSCRIPTION.EXPIRED": "cancelled",
    };
    const status = statusMap[event.event_type];
    if (status)
      await db
        .update(subscriptions)
        .set({
          billingStatus: status,
          ...(status === "active" ? {} : { plan: "free" as const }),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.paypalSubscriptionId, subscriptionId));
  }
  return c.json({ received: true });
});

export default billingRouter;
