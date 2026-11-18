import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db, defer } from "../db";
import {
  discountCodes,
  discountRedemptions,
  paymentEvents,
  subscriptions,
  users,
} from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import {
  dodoConfigured,
  dodoProductId,
  dodoRequest,
  planForProduct,
  PAYMENT_GRACE_DAYS,
  subscriptionTrialEnd,
  trialDaysLeft,
  verifyDodoWebhook,
  type DodoSubscription,
  type PaidPlan,
} from "../services/dodo";
import { frontendUrl, sendEmail } from "../services/email";
import { invalidatePlan, planCatalog } from "../services/entitlements";

const dodoRouter = new Hono<AppEnv>();
const planNames = { pro: "Pro", business: "Team" } as const;

type SubscriptionRow = typeof subscriptions.$inferSelect;

function longDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Days until the first charge. Trial users (and anyone whose already-paid
 * access is still running) pay nothing until that access ends.
 */
export function deferredDays(row: SubscriptionRow, plan: PaidPlan) {
  // A failed payment is not prepaid time: never turn it into a free trial.
  if (row.billingStatus === "past_due") return 0;
  const renewing =
    row.billingStatus === "active" &&
    Boolean(row.dodoSubscriptionId || row.paypalSubscriptionId);
  if (renewing || row.plan === "free") return 0;
  // Trial = never had a paid subscription. Paid-then-cancelled access only
  // carries over to the same plan, so nobody gets a free upgrade.
  const onTrial = !row.dodoSubscriptionId && !row.paypalSubscriptionId;
  if (!onTrial && row.plan !== plan) return 0;
  return trialDaysLeft(row.currentPeriodEnd);
}

/**
 * Days of trial a checkout for `plan` gets right now. Same answer for the
 * billing page preview and the real checkout. A subscription still inside
 * its free trial keeps the rest of that trial when switching plans.
 */
export async function checkoutDeferredDays(
  row: SubscriptionRow,
  plan: PaidPlan,
  current?: DodoSubscription,
) {
  if (!(row.dodoSubscriptionId && row.billingStatus === "active"))
    return deferredDays(row, plan);
  const sub =
    current ||
    (await dodoRequest<DodoSubscription>(
      `/subscriptions/${row.dodoSubscriptionId}`,
    ).catch(() => null));
  const trialEnd = sub ? subscriptionTrialEnd(sub) : null;
  return trialEnd ? trialDaysLeft(trialEnd) : 0;
}

async function accountRow(userId: string) {
  let row = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });
  if (!row)
    [row] = await db.insert(subscriptions).values({ userId }).returning();
  return row;
}

/** Finds or creates the Dodo discount mirroring one of our discount codes. */
async function dodoDiscountCode(code: string, plan: PaidPlan) {
  const discount = await db.query.discountCodes.findFirst({
    where: and(
      eq(discountCodes.code, code.trim().toUpperCase()),
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
  )
    throw new HttpError(400, "Discount code is invalid or no longer available");
  // Test and live are separate Dodo accounts; remember which one the id is for.
  const mode = process.env.DODO_ENV === "live" ? "live" : "test";
  if (discount.dodoDiscountId?.startsWith(`${mode}:`)) return discount;
  const plans: PaidPlan[] = discount.plan
    ? [discount.plan as PaidPlan]
    : ["pro", "business"];
  let created: { discount_id: string };
  try {
    created = await dodoRequest<{ discount_id: string }>("/discounts", {
      method: "POST",
      body: JSON.stringify({
        code: discount.code,
        name: `Danto ${discount.code}`,
        type: "percentage",
        amount: discount.percentOff * 100,
        subscription_cycles: 1,
        restricted_to: plans.map((p) => dodoProductId(p, "month")),
        per_customer_usage_limit: 1,
        expires_at: discount.expiresAt?.toISOString() ?? null,
      }),
    });
  } catch (error) {
    // Already created (e.g. a previous attempt failed after Dodo saved it).
    created = await dodoRequest<{ discount_id: string }>(
      `/discounts/code/${encodeURIComponent(discount.code)}`,
    ).catch(() => {
      throw error;
    });
  }
  await db
    .update(discountCodes)
    .set({ dodoDiscountId: `${mode}:${created.discount_id}`, updatedAt: now })
    .where(eq(discountCodes.id, discount.id));
  return discount;
}

/** Start checkout, or switch plan on an existing renewing subscription. */
dodoRouter.post("/billing/checkout", async (c) => {
  const userId = c.get("userId");
  const input = await body(
    c,
    z.object({
      plan: z.enum(["pro", "business"]),
      interval: z.enum(["month", "year"]).default("month"),
      discountCode: z.string().min(3).max(30).optional(),
    }),
  );
  if (!dodoConfigured()) throw new HttpError(503, "Checkout is not configured");
  if (input.discountCode && input.interval === "year")
    throw new HttpError(
      400,
      "Discount codes apply to monthly plans. Yearly already includes 2 months free.",
    );
  const row = await accountRow(userId);
  const productId = dodoProductId(input.plan, input.interval);
  let days = deferredDays(row, input.plan);

  if (row.dodoSubscriptionId && row.billingStatus === "active") {
    const current = await dodoRequest<DodoSubscription>(
      `/subscriptions/${row.dodoSubscriptionId}`,
    );
    if (current.product_id === productId)
      throw new HttpError(409, "You're already on this plan");
    // Still in the free trial: Dodo's change-plan would charge right away.
    // Start a new subscription with the remaining trial instead; the old one
    // is cancelled once the new one is active (see applySubscription).
    days = await checkoutDeferredDays(row, input.plan, current);
  }

  if (row.dodoSubscriptionId && row.billingStatus === "active" && !days) {
    await dodoRequest(`/subscriptions/${row.dodoSubscriptionId}/change-plan`, {
      method: "POST",
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        proration_billing_mode: "prorated_immediately",
      }),
    });
    const updated = await dodoRequest<DodoSubscription>(
      `/subscriptions/${row.dodoSubscriptionId}`,
    );
    await applySubscription(updated, userId);
    return c.json({ changed: true });
  }

  const discount = input.discountCode
    ? await dodoDiscountCode(input.discountCode, input.plan)
    : null;
  const account = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!account) throw new HttpError(404, "Account not found");
  const session = await dodoRequest<{ session_id: string; checkout_url: string }>(
    "/checkouts",
    {
      method: "POST",
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: row.dodoCustomerId
          ? { customer_id: row.dodoCustomerId }
          : { email: account.email, name: account.name },
        ...(days > 0 ? { subscription_data: { trial_period_days: days } } : {}),
        ...(discount ? { discount_codes: [discount.code] } : {}),
        metadata: {
          user_id: userId,
          plan: input.plan,
          interval: input.interval,
          ...(discount ? { discount_code_id: discount.id } : {}),
        },
        return_url: frontendUrl("/billing?checkout=done"),
        cancel_url: frontendUrl("/billing"),
        customization: { theme: "light" },
      }),
    },
  );
  return c.json({
    checkoutUrl: session.checkout_url,
    deferredDays: days,
    firstChargeAt:
      days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
  });
});

/** Called by the billing page after Dodo redirects back. */
dodoRouter.post("/billing/checkout/confirm", async (c) => {
  const userId = c.get("userId");
  const { subscriptionId } = await body(
    c,
    z.object({ subscriptionId: z.string().min(3).max(100) }),
  );
  const subscription = await dodoRequest<DodoSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  if (subscription.metadata?.user_id !== userId)
    throw new HttpError(400, "Subscription account mismatch");
  if (subscription.status === "pending")
    return c.json({ status: "pending" }, 202);
  await applySubscription(subscription, userId);
  return c.json({ status: subscription.status });
});

dodoRouter.post("/billing/portal", async (c) => {
  const row = await accountRow(c.get("userId"));
  if (!row.dodoCustomerId)
    throw new HttpError(409, "No billing account found yet");
  const session = await dodoRequest<{ link: string }>(
    `/customers/${row.dodoCustomerId}/customer-portal/session?return_url=${encodeURIComponent(frontendUrl("/billing"))}`,
    { method: "POST" },
  );
  return c.json({ url: session.link });
});

/** Stops renewal; access continues until the paid (or trial) period ends. */
export async function cancelDodoRenewal(row: SubscriptionRow) {
  await dodoRequest(`/subscriptions/${row.dodoSubscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify({ cancel_at_next_billing_date: true }),
  });
  await db
    .update(subscriptions)
    .set({ billingStatus: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.userId, row.userId));
  invalidatePlan(row.userId);
}

/**
 * Writes a Dodo subscription's state onto the account. Safe to call many
 * times (confirm + several webhooks) with the same subscription.
 */
export async function applySubscription(
  sub: DodoSubscription,
  knownUserId?: string,
) {
  const byId = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.dodoSubscriptionId, sub.subscription_id),
  });
  const userId = byId?.userId || knownUserId || sub.metadata?.user_id;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return;
  const row = byId || (await accountRow(userId));
  const product = planForProduct(sub.product_id);
  if (!product) {
    console.error("Dodo subscription for unknown product", sub.product_id);
    return;
  }
  // A late event for an old subscription must not overwrite a newer one.
  // Only a paid/trialing (active) subscription can be linked; a cancelled or
  // on-hold event for a subscription we don't track (an old or reset one)
  // must never grant access until its next billing date.
  const isNew = row.dodoSubscriptionId !== sub.subscription_id;
  if (isNew && sub.status !== "active") return;
  if (sub.status === "pending") return;

  const status =
    sub.status === "active"
      ? sub.cancel_at_next_billing_date
        ? "cancelled"
        : "active"
      : sub.status === "cancelled" || sub.status === "expired"
        ? "cancelled"
        : "past_due";
  // Cancelled/expired keep access until the period they paid for ends. A
  // failed payment (on hold) only gets a short grace period: Dodo's
  // next_billing_date then points a whole period ahead, which would
  // otherwise mean a free month or year.
  let periodEnd = sub.next_billing_date
    ? new Date(sub.next_billing_date)
    : row.currentPeriodEnd;
  if (status === "past_due") {
    const failedAt = sub.previous_billing_date
      ? new Date(sub.previous_billing_date)
      : new Date();
    const grace = new Date(
      failedAt.getTime() + PAYMENT_GRACE_DAYS * 86_400_000,
    );
    periodEnd = periodEnd && periodEnd < grace ? periodEnd : grace;
  }
  // Cancelling after a failed payment doesn't turn the unpaid period into
  // paid time: keep the grace end already stored.
  if (
    status === "cancelled" &&
    row.billingStatus === "past_due" &&
    row.dodoSubscriptionId === sub.subscription_id &&
    row.currentPeriodEnd &&
    (!periodEnd || row.currentPeriodEnd < periodEnd)
  )
    periodEnd = row.currentPeriodEnd;
  const discountId = sub.metadata?.discount_code_id || null;
  // Confirm and webhooks race: only the request that links the subscription
  // first sends the welcome email and counts the discount.
  const claimed =
    isNew && sub.status === "active"
      ? (
          await db
            .update(subscriptions)
            .set({ dodoSubscriptionId: sub.subscription_id })
            .where(
              and(
                eq(subscriptions.userId, userId),
                or(
                  isNull(subscriptions.dodoSubscriptionId),
                  ne(subscriptions.dodoSubscriptionId, sub.subscription_id),
                ),
              ),
            )
            .returning({ userId: subscriptions.userId })
        ).length > 0
      : false;
  await db
    .update(subscriptions)
    .set({
      plan: product.plan,
      billingStatus: status,
      billingInterval: product.interval,
      dodoSubscriptionId: sub.subscription_id,
      dodoCustomerId: sub.customer?.customer_id || row.dodoCustomerId,
      currentPeriodEnd:
        sub.status === "expired" ? new Date() : (periodEnd ?? null),
      ...(isNew ? { discountCodeId: discountId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));
  invalidatePlan(userId);

  // A newer subscription replaced an older one (plan change during the
  // trial, or a fresh checkout after a failed payment): stop the old one so
  // it can never bill again.
  const replaced = row.dodoSubscriptionId;
  if (claimed && replaced && replaced !== sub.subscription_id)
    await dodoRequest(`/subscriptions/${replaced}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "cancelled",
        cancel_reason: "cancelled_by_merchant",
      }),
    }).catch((error) =>
      console.error("Could not cancel replaced Dodo subscription", {
        replaced,
        message: error instanceof Error ? error.message : String(error),
      }),
    );

  if (!claimed) return;
  if (discountId) await recordRedemption(discountId, userId, product.plan);
  const account = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!account) return;
  const name = planNames[product.plan];
  const firstCharge = sub.trial_period_days > 0 ? periodEnd : null;
  const price =
    product.interval === "year"
      ? planCatalog[product.plan].yearlyPriceUsd
      : planCatalog[product.plan].priceUsd;
  const amount = `$${price.toFixed(2)} USD`;
  const every = product.interval === "year" ? "every year" : "every month";
  defer(() =>
    sendEmail({
      to: account.email,
      subject: `You're on Danto ${name}`,
      eyebrow: "Subscription active",
      title: `Welcome to ${name}`,
      message: firstCharge
        ? `Your ${name} plan is active. Nothing was charged today. Your first payment of ${amount} (plus any sales tax) is on ${longDate(firstCharge)}, when your trial ends, then ${amount} ${every} until you cancel. Cancel before ${longDate(firstCharge)} and you won't be charged at all.`
        : `Your ${name} plan is active. Unlimited client portals, your branding and AI client updates are switched on. Dodo Payments emails an invoice for every payment.`,
      details: [
        ["Plan", name],
        ["Billing", `${amount} ${every}`],
        ...(periodEnd
          ? ([
              [firstCharge ? "First payment" : "Next payment", longDate(periodEnd)],
            ] as Array<[string, string]>)
          : []),
        ["Manage", "Cancel anytime from your billing page"],
      ],
      actionLabel: "Open billing",
      actionUrl: frontendUrl("/billing"),
    }),
  );
}

async function recordRedemption(
  discountCodeId: string,
  userId: string,
  plan: PaidPlan,
) {
  const inserted = await db
    .insert(discountRedemptions)
    .values({ discountCodeId, userId, plan })
    .onConflictDoNothing()
    .returning({ id: discountRedemptions.id });
  if (inserted.length)
    await db
      .update(discountCodes)
      .set({
        redemptionCount: sql`${discountCodes.redemptionCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(discountCodes.id, discountCodeId));
}

// ---- Webhook ---------------------------------------------------------------

export const dodoWebhook = new Hono();
dodoWebhook.post("/dodo", async (c) => {
  const raw = await c.req.text();
  const valid = await verifyDodoWebhook(raw, {
    id: c.req.header("webhook-id"),
    timestamp: c.req.header("webhook-timestamp"),
    signature: c.req.header("webhook-signature"),
  });
  if (!valid) throw new HttpError(400, "Invalid webhook signature");
  const event = JSON.parse(raw) as { type: string; data: any };
  const data = event.data || {};

  if (event.type.startsWith("subscription.") && data.subscription_id) {
    // Re-read the subscription so out-of-order events can't apply stale state.
    const fresh = await dodoRequest<DodoSubscription>(
      `/subscriptions/${data.subscription_id}`,
    );
    await applySubscription(fresh);
  }

  if (event.type === "payment.succeeded" && data.payment_id) {
    const owner = data.subscription_id
      ? await db.query.subscriptions.findFirst({
          where: eq(subscriptions.dodoSubscriptionId, data.subscription_id),
        })
      : null;
    const userId = owner?.userId || data.metadata?.user_id || null;
    await db
      .insert(paymentEvents)
      .values({
        provider: "dodo",
        providerEventId: data.payment_id,
        providerSubscriptionId: data.subscription_id || null,
        userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        plan: owner?.plan || data.metadata?.plan || null,
        status: "completed",
        amount: (Number(data.total_amount || 0) / 100).toFixed(2),
        currency: data.currency || "USD",
        occurredAt: new Date(data.created_at || Date.now()),
      })
      .onConflictDoNothing();
  }

  if (event.type === "refund.succeeded" && data.refund_id) {
    const original = await db.query.paymentEvents.findFirst({
      where: eq(paymentEvents.providerEventId, data.payment_id),
    });
    await db
      .insert(paymentEvents)
      .values({
        provider: "dodo",
        providerEventId: data.refund_id,
        providerSubscriptionId: original?.providerSubscriptionId || null,
        userId: original?.userId || null,
        plan: original?.plan || null,
        status: "refunded",
        amount: (Number(data.amount || 0) / 100).toFixed(2),
        currency: data.currency || original?.currency || "USD",
        occurredAt: new Date(data.created_at || Date.now()),
      })
      .onConflictDoNothing();
  }

  return c.json({ received: true });
});

export default dodoRouter;
