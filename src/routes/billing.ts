import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { filesAvailable, storageUsedBytes } from "../services/storage";
import { z } from "zod";

import { db } from "../db";
import {
  discountCodes,
  paymentEvents,
  subscriptions,
} from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import { dodoConfigured } from "../services/dodo";
import { cancelDodoRenewal, deferredDays } from "./dodo";
import { receiptDetails, receiptNumber } from "../services/receipts";
import { effectivePlan, planCatalog } from "../services/entitlements";

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
  return c.json({
    plan,
    billingStatus: subscription.billingStatus,
    currentPeriodEnd: subscription.currentPeriodEnd,
    aiRequestsThisMonth: subscription.aiRequestsThisMonth,
    aiPeriodStart: subscription.aiPeriodStart,
    subscriptionId: subscription.dodoSubscriptionId,
    provider: subscription.dodoSubscriptionId ? "dodo" : null,
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
  throw new HttpError(409, "No active subscription found");
});

export default billingRouter;
