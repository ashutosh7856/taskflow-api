import { and, desc, eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { filesAvailable, storageUsedBytes } from "../services/storage";
import { z } from "zod";

import { db, defer } from "../db";
import {
  annualBillingPlans,
  billingPlans,
  discountCodes,
  discountRedemptions,
  paymentEvents,
  subscriptions,
  users,
} from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import {
  paypalConfigured,
  paypalPlanUsable,
  paypalRequest,
} from "../services/paypal";
import { frontendUrl, sendEmail } from "../services/email";
import { dodoConfigured } from "../services/dodo";
import { cancelDodoRenewal, deferredDays } from "./dodo";
import {
  claimUnlinkedPayments,
  receiptDetails,
  receiptNumber,
  sendReceipt,
} from "../services/receipts";
import {
  effectivePlan,
  invalidatePlan,
  planCatalog,
} from "../services/entitlements";

const billingRouter = new Hono<AppEnv>();
const paidPlanSchema = z.enum(["pro", "business"]);

async function activeDiscount(code: string, plan: "pro" | "business") {
  const normalized = code.trim().toUpperCase();
  const discount = await db.query.discountCodes.findFirst({
    where: and(
      eq(discountCodes.code, normalized),
      eq(discountCodes.active, true),
    ),
  });
  const now = new Date();
  if (
    !discount ||
    (discount.plan && discount.plan !== plan) ||
    (discount.startsAt && discount.startsAt > now) ||
    (discount.expiresAt && discount.expiresAt <= now) ||
    (discount.maxRedemptions !== null &&
      discount.redemptionCount >= discount.maxRedemptions)
  ) {
    throw new HttpError(400, "Discount code is invalid or no longer available");
  }
  return discount;
}

function discountedPrice(price: number, percentOff: number) {
  return Math.max(1, Math.round(price * (100 - percentOff)) / 100);
}

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
  const plan = effectivePlan(subscription);
  const plans = await db
    .select()
    .from(billingPlans)
    .where(eq(billingPlans.active, true));
  return c.json({
    plan,
    billingStatus: subscription.billingStatus,
    currentPeriodEnd: subscription.currentPeriodEnd,
    aiRequestsThisMonth: subscription.aiRequestsThisMonth,
    aiPeriodStart: subscription.aiPeriodStart,
    paypalSubscriptionId: subscription.paypalSubscriptionId,
    // Whichever provider bills this account (Dodo preferred).
    subscriptionId:
      subscription.dodoSubscriptionId || subscription.paypalSubscriptionId,
    provider: subscription.dodoSubscriptionId
      ? "dodo"
      : subscription.paypalSubscriptionId
        ? "paypal"
        : null,
    canManagePayment: Boolean(subscription.dodoCustomerId),
    // Days until the first charge if this account checked out now (trial).
    deferredDays: {
      pro: deferredDays(subscription, "pro"),
      business: deferredDays(subscription, "business"),
    },
    checkout: {
      provider: "dodo",
      configured: dodoConfigured(),
      environment: process.env.DODO_ENV === "live" ? "live" : "test",
    },
    billingInterval: subscription.billingInterval,
    entitlements: planCatalog[plan],
    storage: {
      enabled: filesAvailable(),
      usedBytes: await storageUsedBytes(subscription.userId),
      limitBytes: planCatalog[plan].storageMb * 1024 * 1024,
    },
    prices: {
      pro: {
        month: planCatalog.pro.priceUsd,
        year: planCatalog.pro.yearlyPriceUsd,
      },
      business: {
        month: planCatalog.business.priceUsd,
        year: planCatalog.business.yearlyPriceUsd,
      },
    },
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

billingRouter.post("/billing/discounts/validate", async (c) => {
  const { code, plan } = await body(
    c,
    z.object({ code: z.string().min(3).max(30), plan: paidPlanSchema }),
  );
  const discount = await activeDiscount(code, plan);
  const priceUsd = planCatalog[plan].priceUsd;
  return c.json({
    code: discount.code,
    percentOff: discount.percentOff,
    regularPriceUsd: priceUsd,
    firstPaymentUsd: discountedPrice(priceUsd, discount.percentOff),
    duration: "first_payment",
  });
});

billingRouter.post("/billing/paypal/setup", async (c) => {
  const userId = c.get("userId");
  const { plan, discountCode, interval } = await body(
    c,
    z.object({
      plan: paidPlanSchema,
      interval: z.enum(["month", "year"]).default("month"),
      discountCode: z.string().min(3).max(30).optional(),
    }),
  );
  if (interval === "year") {
    if (discountCode)
      throw new HttpError(
        400,
        "Discount codes apply to monthly plans. Yearly already includes 2 months free.",
      );
    return c.json(await yearlyPlan(plan));
  }
  const discount = discountCode
    ? await activeDiscount(discountCode, plan)
    : null;
  const existing = await db.query.billingPlans.findFirst({
    where: eq(billingPlans.plan, plan),
  });
  const priceUsd = planCatalog[plan].priceUsd;
  const existingUsable =
    Boolean(existing) &&
    existing!.priceUsd === priceUsd &&
    (await paypalPlanUsable(existing!.paypalPlanId));
  if (existing && existingUsable && !discount)
    return c.json({
      plan,
      priceUsd: existing.priceUsd,
      paypalPlanId: existing.paypalPlanId,
    });
  let basePlan = existing;
  if (!basePlan || !existingUsable) {
    const product = await paypalRequest<{ id: string }>(
      "/v1/catalogs/products",
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": `danto-${plan}-account-product-v4-${priceUsd}`,
        },
        body: JSON.stringify({
          name: `Danto ${plan === "pro" ? "Pro" : "Team"}`,
          description:
            "Danto account subscription covering all owned workspaces",
          type: "SERVICE",
          category: "SOFTWARE",
        }),
      },
    );
    const paypalPlan = await paypalRequest<{ id: string }>(
      "/v1/billing/plans",
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": `danto-${plan}-account-monthly-v4-${priceUsd}`,
        },
        body: JSON.stringify({
          product_id: product.id,
          name: `Danto ${plan === "pro" ? "Pro" : "Team"} monthly`,
          status: "ACTIVE",
          billing_cycles: [
            {
              frequency: { interval_unit: "MONTH", interval_count: 1 },
              tenure_type: "REGULAR",
              sequence: 1,
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: {
                  value: priceUsd.toFixed(2),
                  currency_code: "USD",
                },
              },
            },
          ],
          payment_preferences: {
            auto_bill_outstanding: true,
            payment_failure_threshold: 2,
          },
        }),
      },
    );
    const [created] = existing
      ? await db
          .update(billingPlans)
          .set({
            paypalProductId: product.id,
            paypalPlanId: paypalPlan.id,
            priceUsd,
            active: true,
          })
          .where(eq(billingPlans.plan, plan))
          .returning()
      : await db
          .insert(billingPlans)
          .values({
            plan,
            paypalProductId: product.id,
            paypalPlanId: paypalPlan.id,
            priceUsd,
          })
          .returning();
    basePlan = created;
    // Discount plans cached for this tier were priced against the old base
    // price; clear them so the next checkout builds one at the new price.
    await db.update(discountCodes).set({
      [plan === "pro" ? "paypalProPlanId" : "paypalBusinessPlanId"]: null,
      updatedAt: new Date(),
    });
    if (discount) {
      discount[plan === "pro" ? "paypalProPlanId" : "paypalBusinessPlanId"] =
        null;
    }
  }
  if (!discount) {
    return c.json(
      {
        plan,
        priceUsd: basePlan!.priceUsd,
        paypalPlanId: basePlan!.paypalPlanId,
      },
      201,
    );
  }
  const discountPlanField =
    plan === "pro" ? "paypalProPlanId" : "paypalBusinessPlanId";
  const cachedPlanId = discount[discountPlanField];
  if (cachedPlanId && (await paypalPlanUsable(cachedPlanId))) {
    return c.json({
      plan,
      priceUsd,
      firstPaymentUsd: discountedPrice(priceUsd, discount.percentOff),
      discountCode: discount.code,
      paypalPlanId: cachedPlanId,
    });
  }
  const firstPaymentUsd = discountedPrice(priceUsd, discount.percentOff);
  const paypalPlan = await paypalRequest<{ id: string }>("/v1/billing/plans", {
    method: "POST",
    headers: {
      "PayPal-Request-Id": `danto-${plan}-${discount.id}-${priceUsd}`,
    },
    body: JSON.stringify({
      product_id: basePlan!.paypalProductId,
      name: `Danto ${plan === "pro" ? "Pro" : "Team"} · ${discount.code}`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "TRIAL",
          sequence: 1,
          total_cycles: 1,
          pricing_scheme: {
            fixed_price: {
              value: firstPaymentUsd.toFixed(2),
              currency_code: "USD",
            },
          },
        },
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 2,
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
  await db
    .update(discountCodes)
    .set({ [discountPlanField]: paypalPlan.id, updatedAt: new Date() })
    .where(eq(discountCodes.id, discount.id));
  return c.json({
    plan,
    priceUsd,
    firstPaymentUsd,
    discountCode: discount.code,
    paypalPlanId: paypalPlan.id,
  });
});

/** Finds or creates the PayPal yearly plan for a tier at the current price. */
async function yearlyPlan(plan: "pro" | "business") {
  const priceUsd = planCatalog[plan].yearlyPriceUsd;
  const existing = await db.query.annualBillingPlans.findFirst({
    where: eq(annualBillingPlans.plan, plan),
  });
  if (
    existing &&
    existing.priceUsd === priceUsd &&
    existing.active &&
    (await paypalPlanUsable(existing.paypalPlanId))
  )
    return {
      plan,
      interval: "year",
      priceUsd,
      paypalPlanId: existing.paypalPlanId,
    };
  const name = `Danto ${plan === "pro" ? "Pro" : "Team"}`;
  const product = await paypalRequest<{ id: string }>("/v1/catalogs/products", {
    method: "POST",
    headers: { "PayPal-Request-Id": `danto-${plan}-account-product-yearly-v1` },
    body: JSON.stringify({
      name,
      description: "Danto account subscription covering all owned workspaces",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  const paypalPlan = await paypalRequest<{ id: string }>("/v1/billing/plans", {
    method: "POST",
    headers: {
      "PayPal-Request-Id": `danto-${plan}-account-yearly-v1-${priceUsd}`,
    },
    body: JSON.stringify({
      product_id: product.id,
      name: `${name} yearly`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "YEAR", interval_count: 1 },
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
  const values = {
    paypalProductId: product.id,
    paypalPlanId: paypalPlan.id,
    priceUsd,
    active: true,
  };
  await db
    .insert(annualBillingPlans)
    .values({ plan, ...values })
    .onConflictDoUpdate({ target: annualBillingPlans.plan, set: values });
  return { plan, interval: "year", priceUsd, paypalPlanId: paypalPlan.id };
}

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
  const basePlan = await db.query.billingPlans.findFirst({
    where: eq(billingPlans.paypalPlanId, paypalSubscription.plan_id),
  });
  const annualPlan = basePlan
    ? null
    : await db.query.annualBillingPlans.findFirst({
        where: eq(annualBillingPlans.paypalPlanId, paypalSubscription.plan_id),
      });
  const discount =
    basePlan || annualPlan
      ? null
      : await db.query.discountCodes.findFirst({
          where: or(
            eq(discountCodes.paypalProPlanId, paypalSubscription.plan_id),
            eq(discountCodes.paypalBusinessPlanId, paypalSubscription.plan_id),
          ),
        });
  const plan =
    basePlan?.plan ||
    annualPlan?.plan ||
    (discount?.paypalProPlanId === paypalSubscription.plan_id
      ? "pro"
      : discount?.paypalBusinessPlanId === paypalSubscription.plan_id
        ? "business"
        : null);
  if (!plan || plan === "free") throw new HttpError(400, "Unknown PayPal plan");
  const [subscription] = await db
    .update(subscriptions)
    .set({
      plan,
      billingStatus: "active",
      paypalSubscriptionId: subscriptionId,
      billingInterval: annualPlan ? "year" : "month",
      discountCodeId: discount?.id || null,
      currentPeriodEnd: paypalSubscription.billing_info?.next_billing_time
        ? new Date(paypalSubscription.billing_info.next_billing_time)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId))
    .returning();
  invalidatePlan(userId);
  await claimUnlinkedPayments(subscriptionId, userId, plan);
  const account = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (account) {
    const planName = plan === "business" ? "Team" : "Pro";
    const nextBilling = subscription?.currentPeriodEnd;
    defer(() =>
      sendEmail({
        to: account.email,
        subject: `You're on Danto ${planName}`,
        eyebrow: "Subscription active",
        title: `Welcome to ${planName}`,
        message: `Your ${planName} plan is active. Unlimited client portals, your branding and AI client updates are switched on. We'll email a receipt for every payment.`,
        details: [
          ["Plan", planName],
          ["Billing", annualPlan ? "Yearly" : "Monthly"],
          ...(nextBilling
            ? ([
                [
                  "Next payment",
                  nextBilling.toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  }),
                ],
              ] as Array<[string, string]>)
            : []),
          ["Manage", "Cancel anytime from your billing page"],
        ],
        actionLabel: "Open billing",
        actionUrl: frontendUrl("/billing"),
      }),
    );
  }
  if (discount) {
    const inserted = await db
      .insert(discountRedemptions)
      .values({ discountCodeId: discount.id, userId, plan })
      .onConflictDoNothing()
      .returning({ id: discountRedemptions.id });
    if (inserted.length) {
      await db
        .update(discountCodes)
        .set({
          redemptionCount: sql`${discountCodes.redemptionCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(discountCodes.id, discount.id));
    }
  }
  return c.json(subscription);
});

billingRouter.get("/billing/receipts", async (c) => {
  const rows = await db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.userId, c.get("userId")))
    .orderBy(desc(paymentEvents.occurredAt))
    .limit(100);
  return c.json(
    rows.map((row) => ({
      id: row.id,
      number: receiptNumber(row),
      status: row.status,
      amount: Number(row.amount),
      currency: row.currency,
      plan: row.plan,
      issuedAt: row.occurredAt.toISOString(),
    })),
  );
});

billingRouter.get("/billing/receipts/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success)
    throw new HttpError(404, "Receipt not found");
  const receipt = await receiptDetails(id, c.get("userId"));
  if (!receipt) throw new HttpError(404, "Receipt not found");
  return c.json(receipt);
});

billingRouter.post("/billing/cancel", async (c) => {
  const userId = c.get("userId");
  const subscription = await accountSubscription(userId);
  if (subscription.dodoSubscriptionId) {
    await cancelDodoRenewal(subscription);
    return c.json({ cancelled: true });
  }
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
  invalidatePlan(userId);
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
  if (
    ["PAYMENT.SALE.COMPLETED", "PAYMENT.SALE.REFUNDED"].includes(
      event.event_type,
    ) &&
    event.resource?.amount?.total
  ) {
    const providerSubscriptionId = event.resource.billing_agreement_id || null;
    let account = providerSubscriptionId
      ? await db.query.subscriptions.findFirst({
          where: eq(subscriptions.paypalSubscriptionId, providerSubscriptionId),
        })
      : null;
    // Subscriptions are created with custom_id = our user id; PayPal echoes
    // it on the sale, which identifies the payer before /activate runs.
    const customId = String(
      event.resource.custom || event.resource.custom_id || "",
    );
    if (!account && /^[0-9a-f-]{36}$/i.test(customId))
      account =
        (await db.query.subscriptions.findFirst({
          where: eq(subscriptions.userId, customId),
        })) || null;
    const inserted = await db
      .insert(paymentEvents)
      .values({
        provider: "paypal",
        providerEventId: event.id,
        providerSubscriptionId,
        userId: account?.userId || null,
        plan: account?.plan || null,
        status:
          event.event_type === "PAYMENT.SALE.COMPLETED"
            ? "completed"
            : "refunded",
        amount: String(event.resource.amount.total),
        currency: event.resource.amount.currency || "USD",
        occurredAt: new Date(event.create_time || Date.now()),
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id, userId: paymentEvents.userId });
    // PayPal retries webhooks; only a newly recorded payment gets a receipt.
    const payment = inserted[0];
    if (payment?.userId) defer(() => sendReceipt(payment.id));
  }
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
    if (status) {
      const updated = await db
        .update(subscriptions)
        .set({
          billingStatus: status,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.paypalSubscriptionId, subscriptionId))
        .returning({ userId: subscriptions.userId });
      for (const row of updated) invalidatePlan(row.userId);
    }
  }
  return c.json({ received: true });
});

export default billingRouter;
