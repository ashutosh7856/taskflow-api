import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  aiUsageEvents,
  discountCodes,
  paymentEvents,
  subscriptions,
  users,
  workspaces,
} from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import { assertAdmin } from "../services/admin";
import { planCatalog } from "../services/entitlements";

const adminRouter = new Hono<AppEnv>();
adminRouter.use("*", async (c, next) => {
  await assertAdmin(c.get("userId"));
  await next();
});

adminRouter.get("/admin/overview", async (c) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [userRows, workspaceRows, subscriptionRows, aiRows, revenueRows] =
    await Promise.all([
      db.select({ total: count() }).from(users),
      db.select({ total: count() }).from(workspaces),
      db
        .select({ plan: subscriptions.plan, total: count() })
        .from(subscriptions)
        .where(eq(subscriptions.billingStatus, "active"))
        .groupBy(subscriptions.plan),
      db
        .select({
          actions: count(),
          inputTokens: sum(aiUsageEvents.inputTokens),
          outputTokens: sum(aiUsageEvents.outputTokens),
          costMicrousd: sum(aiUsageEvents.estimatedCostMicrousd),
        })
        .from(aiUsageEvents)
        .where(gte(aiUsageEvents.createdAt, thirtyDaysAgo)),
      db
        .select({ amount: sum(paymentEvents.amount) })
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.status, "completed"),
            gte(paymentEvents.occurredAt, thirtyDaysAgo),
          ),
        ),
    ]);
  const activePlans = Object.fromEntries(
    subscriptionRows.map((row) => [row.plan, Number(row.total)]),
  );
  const estimatedMrr =
    (activePlans.pro || 0) * planCatalog.pro.priceUsd +
    (activePlans.business || 0) * planCatalog.business.priceUsd;
  return c.json({
    users: Number(userRows[0]?.total || 0),
    workspaces: Number(workspaceRows[0]?.total || 0),
    activePlans,
    estimatedMrr,
    collectedLast30Days: Number(revenueRows[0]?.amount || 0),
    aiLast30Days: {
      actions: Number(aiRows[0]?.actions || 0),
      inputTokens: Number(aiRows[0]?.inputTokens || 0),
      outputTokens: Number(aiRows[0]?.outputTokens || 0),
      estimatedCostUsd: Number(aiRows[0]?.costMicrousd || 0) / 1_000_000,
    },
  });
});

adminRouter.get("/admin/discounts", async (c) => {
  return c.json(
    await db
      .select()
      .from(discountCodes)
      .orderBy(sql`${discountCodes.createdAt} desc`),
  );
});

const discountSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((value) => value.toUpperCase()),
  percentOff: z.number().int().min(5).max(50),
  plan: z.enum(["pro", "business"]).nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

adminRouter.post("/admin/discounts", async (c) => {
  const input = await body(c, discountSchema);
  if (input.startsAt && input.expiresAt && input.startsAt >= input.expiresAt) {
    throw new HttpError(400, "Expiry must be after the start date");
  }
  const [created] = await db
    .insert(discountCodes)
    .values({
      ...input,
      plan: input.plan || null,
      maxRedemptions: input.maxRedemptions || null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    })
    .returning();
  return c.json(created, 201);
});

adminRouter.patch("/admin/discounts/:id", async (c) => {
  const input = await body(c, z.object({ active: z.boolean() }));
  const [updated] = await db
    .update(discountCodes)
    .set({ active: input.active, updatedAt: new Date() })
    .where(eq(discountCodes.id, c.req.param("id")))
    .returning();
  if (!updated) throw new HttpError(404, "Discount code not found");
  return c.json(updated);
});

export default adminRouter;
