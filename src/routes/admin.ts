import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  like,
  inArray,
  isNotNull,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  activityLogs,
  adminAuditLogs,
  aiUsageEvents,
  boards,
  cards,
  clientFeedback,
  discountCodes,
  discountRedemptions,
  lists,
  paymentEvents,
  subscriptions,
  userFeedback,
  users,
  workspaces,
} from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import { assertAdmin, invalidateAdmin } from "../services/admin";
import { cached, invalidate } from "../lib/cache";
import { frontendUrl, sendEmail } from "../services/email";
import {
  effectivePlan,
  invalidatePlan,
  planCatalog,
} from "../services/entitlements";
import { sendPasswordResetLink } from "../services/password-reset";
import { receiptNumber, sendReceipt } from "../services/receipts";
import {
  createDiscountSchema,
  updateDiscountSchema,
} from "../validators/discounts";
import { runWeeklyUpdates } from "../services/client-updates";
import { feedbackInsights, triageFeedback } from "../services/feedback";

const adminRouter = new Hono<AppEnv>();
adminRouter.use("*", async (c, next) => {
  await assertAdmin(c.get("userId"), Boolean(c.get("adminSession")));
  await next();
});

const DAY = 24 * 60 * 60 * 1000;
const MRR_GOAL = 1000;

function audit(
  adminId: string,
  action: string,
  targetUserId: string | null,
  meta?: unknown,
) {
  invalidate("admin-overview");
  return db
    .insert(adminAuditLogs)
    .values({ adminId, action, targetUserId, meta });
}

/* ------------------------------------------------------------------ */
/* Overview: revenue, growth, activation funnel                        */
/* ------------------------------------------------------------------ */

adminRouter.get("/admin/overview", async (c) =>
  // ~20 aggregate queries: shared by all admins for 60s.
  c.json(await cached("admin-overview", 60, () => overviewData())),
);

async function overviewData() {
  const now = Date.now();
  const d30 = new Date(now - 30 * DAY);
  const d7 = new Date(now - 7 * DAY);
  const [
    userRows,
    new7,
    new30,
    active7,
    workspaceRows,
    subscriptionRows,
    aiRows,
    revenueRows,
    portalsLive,
    approvals30,
    feedback30,
    signupSeries,
    revenueSeries,
    cancelled30,
    funnelBoards,
    funnelPortals,
    funnelApprovals,
    sources,
  ] = await Promise.all([
    db.select({ total: count() }).from(users),
    db.select({ total: count() }).from(users).where(gte(users.createdAt, d7)),
    db.select({ total: count() }).from(users).where(gte(users.createdAt, d30)),
    db.select({ total: count() }).from(users).where(gte(users.lastSeenAt, d7)),
    db.select({ total: count() }).from(workspaces),
    db
      .select({
        plan: subscriptions.plan,
        status: subscriptions.billingStatus,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        paypal: sql<string | null>`coalesce(${subscriptions.dodoSubscriptionId}, ${subscriptions.paypalSubscriptionId})`,
        interval: subscriptions.billingInterval,
      })
      .from(subscriptions)
      .where(sql`${subscriptions.plan} <> 'free'`),
    db
      .select({
        actions: count(),
        inputTokens: sum(aiUsageEvents.inputTokens),
        outputTokens: sum(aiUsageEvents.outputTokens),
        costMicrousd: sum(aiUsageEvents.estimatedCostMicrousd),
      })
      .from(aiUsageEvents)
      .where(gte(aiUsageEvents.createdAt, d30)),
    db
      .select({ amount: sum(paymentEvents.amount) })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.status, "completed"),
          gte(paymentEvents.occurredAt, d30),
        ),
      ),
    db
      .select({ total: count() })
      .from(boards)
      .where(eq(boards.portalEnabled, true)),
    db
      .select({ total: count() })
      .from(clientFeedback)
      .where(
        and(
          eq(clientFeedback.kind, "approved"),
          gte(clientFeedback.createdAt, d30),
        ),
      ),
    db
      .select({ total: count() })
      .from(clientFeedback)
      .where(gte(clientFeedback.createdAt, d30)),
    db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${users.createdAt} / 1000, 'unixepoch')`,
        total: count(),
      })
      .from(users)
      .where(gte(users.createdAt, d30))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${paymentEvents.occurredAt} / 1000, 'unixepoch')`,
        amount: sum(paymentEvents.amount),
      })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.status, "completed"),
          gte(paymentEvents.occurredAt, d30),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ total: count() })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingStatus, "cancelled"),
          // Comps are stored as cancelled-with-end-date; only count real ones.
          or(
            isNotNull(subscriptions.dodoSubscriptionId),
            isNotNull(subscriptions.paypalSubscriptionId),
          ),
          gte(subscriptions.updatedAt, d30),
        ),
      ),
    db
      .select({ total: countDistinct(workspaces.ownerId) })
      .from(boards)
      .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id)),
    db
      .select({ total: countDistinct(workspaces.ownerId) })
      .from(boards)
      .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
      .where(isNotNull(boards.portalToken)),
    db
      .select({ total: countDistinct(workspaces.ownerId) })
      .from(cards)
      .innerJoin(lists, eq(cards.listId, lists.id))
      .innerJoin(boards, eq(lists.boardId, boards.id))
      .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
      .where(isNotNull(cards.approvalRequestedAt)),
    db
      .select({
        source: sql<string>`coalesce(${users.signupSource}, 'direct')`,
        total: count(),
      })
      .from(users)
      .where(gte(users.createdAt, d30))
      .groupBy(sql`1`)
      .orderBy(desc(count()))
      .limit(8),
  ]);

  // Reverse-trial health: new accounts get 14 days of Pro with no card.
  const trialRows = await db
    .select({
      createdAt: users.createdAt,
      plan: subscriptions.plan,
      status: subscriptions.billingStatus,
      paypal: sql<string | null>`coalesce(${subscriptions.dodoSubscriptionId}, ${subscriptions.paypalSubscriptionId})`,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(gte(users.createdAt, new Date(now - 75 * DAY)));
  const inTrial = trialRows.filter(
    (row) =>
      row.createdAt.getTime() > now - 15 * DAY &&
      !row.paypal &&
      row.plan &&
      row.plan !== "free" &&
      row.currentPeriodEnd &&
      row.currentPeriodEnd.getTime() > now,
  );
  const finishedTrial = trialRows.filter(
    (row) => row.createdAt.getTime() <= now - 15 * DAY,
  );
  const convertedTrial = finishedTrial.filter(
    (row) => row.paypal && row.status === "active",
  );
  const trials = {
    active: inTrial.length,
    endingIn7Days: inTrial.filter(
      (row) => row.currentPeriodEnd!.getTime() < now + 7 * DAY,
    ).length,
    finished: finishedTrial.length,
    converted: convertedTrial.length,
    conversionRate: finishedTrial.length
      ? convertedTrial.length / finishedTrial.length
      : null,
  };

  const paying = subscriptionRows.filter(
    (row) =>
      effectivePlan({
        plan: row.plan,
        billingStatus: row.status,
        currentPeriodEnd: row.currentPeriodEnd,
      }) !== "free",
  );
  // Comped accounts (no paid subscription) don't count as revenue.
  const billed = paying.filter((row) => row.paypal);
  const activePlans = {
    pro: billed.filter((row) => row.plan === "pro").length,
    business: billed.filter((row) => row.plan === "business").length,
  };
  // Yearly subscribers count as 1/12 of their annual price per month.
  const estimatedMrr = Math.round(
    billed.reduce(
      (total, row) =>
        total +
        (row.interval === "year"
          ? planCatalog[row.plan as "pro" | "business"].yearlyPriceUsd / 12
          : planCatalog[row.plan as "pro" | "business"].priceUsd),
      0,
    ),
  );
  const yearlyCustomers = billed.filter(
    (row) => row.interval === "year",
  ).length;
  const totalUsers = Number(userRows[0]?.total || 0);

  return {
    users: totalUsers,
    trials,
    newUsers7d: Number(new7[0]?.total || 0),
    newUsers30d: Number(new30[0]?.total || 0),
    activeUsers7d: Number(active7[0]?.total || 0),
    workspaces: Number(workspaceRows[0]?.total || 0),
    activePlans,
    compedAccounts: paying.length - billed.length,
    payingCustomers: billed.length,
    yearlyCustomers,
    estimatedMrr,
    mrrGoal: MRR_GOAL,
    arpu: billed.length ? estimatedMrr / billed.length : 0,
    cancelled30d: Number(cancelled30[0]?.total || 0),
    collectedLast30Days: Number(revenueRows[0]?.amount || 0),
    portalsLive: Number(portalsLive[0]?.total || 0),
    approvals30d: Number(approvals30[0]?.total || 0),
    clientInteractions30d: Number(feedback30[0]?.total || 0),
    funnel: [
      { step: "Signed up", total: totalUsers },
      { step: "Created a board", total: Number(funnelBoards[0]?.total || 0) },
      {
        step: "Published a portal",
        total: Number(funnelPortals[0]?.total || 0),
      },
      {
        step: "Requested an approval",
        total: Number(funnelApprovals[0]?.total || 0),
      },
      { step: "Paying", total: billed.length },
    ],
    signupSeries: signupSeries.map((row) => ({
      day: row.day,
      total: Number(row.total),
    })),
    revenueSeries: revenueSeries.map((row) => ({
      day: row.day,
      amount: Number(row.amount || 0),
    })),
    sources: sources.map((row) => ({
      source: row.source,
      total: Number(row.total),
    })),
    aiLast30Days: {
      actions: Number(aiRows[0]?.actions || 0),
      inputTokens: Number(aiRows[0]?.inputTokens || 0),
      outputTokens: Number(aiRows[0]?.outputTokens || 0),
      estimatedCostUsd: Number(aiRows[0]?.costMicrousd || 0) / 1_000_000,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

adminRouter.get("/admin/users", async (c) => {
  const search = (c.req.query("search") || "").trim();
  const filter = c.req.query("filter") || "all";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = 25;

  const conditions = [];
  if (search)
    conditions.push(
      or(like(users.email, `%${search}%`), like(users.name, `%${search}%`)),
    );
  if (filter === "paying")
    conditions.push(
      and(
        sql`${subscriptions.plan} <> 'free'`,
        eq(subscriptions.billingStatus, "active"),
      ),
    );
  if (filter === "free")
    conditions.push(
      or(sql`${subscriptions.plan} is null`, eq(subscriptions.plan, "free")),
    );
  if (filter === "suspended") conditions.push(isNotNull(users.suspendedAt));
  if (filter === "active7d")
    conditions.push(gte(users.lastSeenAt, new Date(Date.now() - 7 * DAY)));
  if (filter === "pastdue")
    conditions.push(eq(subscriptions.billingStatus, "past_due"));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        suspendedAt: users.suspendedAt,
        signupSource: users.signupSource,
        plan: subscriptions.plan,
        billingStatus: subscriptions.billingStatus,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        paypalSubscriptionId: sql<string | null>`coalesce(${subscriptions.dodoSubscriptionId}, ${subscriptions.paypalSubscriptionId})`,
        aiRequestsThisMonth: subscriptions.aiRequestsThisMonth,
      })
      .from(users)
      .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: count() })
      .from(users)
      .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
      .where(where),
  ]);

  const ids = rows.map((row) => row.id);
  const usage = ids.length
    ? await db
        .select({
          ownerId: workspaces.ownerId,
          boards: count(boards.id),
          portals: sql<number>`count(*) filter (where ${boards.portalEnabled})`,
        })
        .from(workspaces)
        .leftJoin(boards, eq(boards.workspaceId, workspaces.id))
        .where(inArray(workspaces.ownerId, ids))
        .groupBy(workspaces.ownerId)
    : [];
  const usageByOwner = new Map(usage.map((row) => [row.ownerId, row]));

  return c.json({
    page,
    pageSize,
    total: Number(total),
    users: rows.map((row) => ({
      ...row,
      effectivePlan: row.plan
        ? effectivePlan({
            plan: row.plan,
            billingStatus: row.billingStatus!,
            currentPeriodEnd: row.currentPeriodEnd,
          })
        : "free",
      boards: Number(usageByOwner.get(row.id)?.boards || 0),
      portals: Number(usageByOwner.get(row.id)?.portals || 0),
    })),
  });
});

adminRouter.get("/admin/users/:id", async (c) => {
  const userId = c.req.param("id");
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { passwordHash: false },
  });
  if (!user) throw new HttpError(404, "User not found");
  const [
    subscription,
    ownedWorkspaces,
    payments,
    ai,
    activity,
    auditTrail,
    redemptions,
  ] = await Promise.all([
    db.query.subscriptions.findFirst({
      where: eq(subscriptions.userId, userId),
    }),
    db.query.workspaces.findMany({
      where: eq(workspaces.ownerId, userId),
      with: { boards: true, members: true },
    }),
    db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.userId, userId))
      .orderBy(desc(paymentEvents.occurredAt))
      .limit(20),
    db
      .select({
        feature: aiUsageEvents.feature,
        total: count(),
        costMicrousd: sum(aiUsageEvents.estimatedCostMicrousd),
      })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.userId, userId),
          gte(aiUsageEvents.createdAt, new Date(Date.now() - 30 * DAY)),
        ),
      )
      .groupBy(aiUsageEvents.feature),
    db
      .select({
        action: activityLogs.action,
        createdAt: activityLogs.createdAt,
        boardName: boards.name,
      })
      .from(activityLogs)
      .innerJoin(boards, eq(activityLogs.boardId, boards.id))
      .where(eq(activityLogs.userId, userId))
      .orderBy(desc(activityLogs.createdAt))
      .limit(25),
    db
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetUserId, userId))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(20),
    db
      .select({
        code: discountCodes.code,
        plan: discountRedemptions.plan,
        createdAt: discountRedemptions.createdAt,
      })
      .from(discountRedemptions)
      .innerJoin(
        discountCodes,
        eq(discountRedemptions.discountCodeId, discountCodes.id),
      )
      .where(eq(discountRedemptions.userId, userId)),
  ]);
  return c.json({
    user,
    subscription: subscription
      ? { ...subscription, effectivePlan: effectivePlan(subscription) }
      : null,
    workspaces: ownedWorkspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      members: workspace.members.length,
      boards: workspace.boards.map((board) => ({
        id: board.id,
        name: board.name,
        template: board.template,
        portalEnabled: board.portalEnabled,
        createdAt: board.createdAt,
      })),
    })),
    payments,
    ai: ai.map((row) => ({
      feature: row.feature,
      total: Number(row.total),
      costUsd: Number(row.costMicrousd || 0) / 1_000_000,
    })),
    activity,
    audit: auditTrail,
    redemptions,
  });
});

adminRouter.post("/admin/users/:id/plan", async (c) => {
  const userId = c.req.param("id");
  const input = await body(
    c,
    z.object({
      plan: z.enum(["free", "pro", "business"]),
      days: z.number().int().min(1).max(3650).nullable().default(30),
      note: z.string().max(300).optional(),
    }),
  );
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new HttpError(404, "User not found");
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });
  if (
    (existing?.dodoSubscriptionId || existing?.paypalSubscriptionId) &&
    existing.billingStatus === "active"
  )
    throw new HttpError(
      409,
      "This user has an active paid subscription. Cancel it first, or they'll keep being billed.",
    );
  const values =
    input.plan === "free"
      ? {
          plan: "free" as const,
          billingStatus: "inactive" as const,
          currentPeriodEnd: null,
        }
      : {
          plan: input.plan,
          // A timed comp is stored as "cancelled with an end date", so
          // effectivePlan downgrades it automatically when the period ends.
          billingStatus: input.days
            ? ("cancelled" as const)
            : ("active" as const),
          currentPeriodEnd: input.days
            ? new Date(Date.now() + input.days * DAY)
            : null,
        };
  await db
    .insert(subscriptions)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: { ...values, updatedAt: new Date() },
    });
  invalidatePlan(userId);
  await audit(c.get("userId"), "user.plan_granted", userId, input);
  return c.json({ ok: true });
});

adminRouter.post("/admin/users/:id/suspend", async (c) => {
  const userId = c.req.param("id");
  const { suspended } = await body(c, z.object({ suspended: z.boolean() }));
  if (userId === c.get("userId"))
    throw new HttpError(400, "You can't suspend your own account");
  await db
    .update(users)
    .set({ suspendedAt: suspended ? new Date() : null })
    .where(eq(users.id, userId));
  invalidateAdmin(userId);
  await audit(
    c.get("userId"),
    suspended ? "user.suspended" : "user.restored",
    userId,
  );
  return c.json({ ok: true });
});

adminRouter.post("/admin/users/:id/reset-ai", async (c) => {
  const userId = c.req.param("id");
  await db
    .update(subscriptions)
    .set({ aiRequestsThisMonth: 0, aiPeriodStart: new Date() })
    .where(eq(subscriptions.userId, userId));
  await audit(c.get("userId"), "user.ai_reset", userId);
  return c.json({ ok: true });
});

adminRouter.post("/admin/users/:id/password-reset", async (c) => {
  const userId = c.req.param("id");
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new HttpError(404, "User not found");
  await sendPasswordResetLink(user);
  await audit(c.get("userId"), "user.password_reset_sent", userId);
  return c.json({ ok: true });
});

adminRouter.post("/admin/users/:id/email", async (c) => {
  const userId = c.req.param("id");
  const input = await body(
    c,
    z.object({
      subject: z.string().trim().min(1).max(160),
      message: z.string().trim().min(1).max(5000),
    }),
  );
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new HttpError(404, "User not found");
  const result = await sendEmail({
    to: user.email,
    subject: input.subject,
    title: input.subject,
    message: input.message,
    actionLabel: "Open Danto",
    actionUrl: frontendUrl("/app"),
    footnote: "Reply to this email to reach the Danto team directly.",
  });
  if (!result.sent)
    throw new HttpError(502, result.reason || "The email could not be sent");
  await audit(c.get("userId"), "user.emailed", userId, {
    subject: input.subject,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Payments & audit                                                    */
/* ------------------------------------------------------------------ */

adminRouter.get("/admin/payments", async (c) => {
  const rows = await db
    .select({
      id: paymentEvents.id,
      status: paymentEvents.status,
      amount: paymentEvents.amount,
      currency: paymentEvents.currency,
      plan: paymentEvents.plan,
      occurredAt: paymentEvents.occurredAt,
      userId: paymentEvents.userId,
      email: users.email,
      name: users.name,
    })
    .from(paymentEvents)
    .leftJoin(users, eq(paymentEvents.userId, users.id))
    .orderBy(desc(paymentEvents.occurredAt))
    .limit(100);
  return c.json(rows.map((row) => ({ ...row, receipt: receiptNumber(row) })));
});

adminRouter.post("/admin/payments/:id/receipt", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success)
    throw new HttpError(404, "Payment not found");
  const payment = await db.query.paymentEvents.findFirst({
    where: eq(paymentEvents.id, id),
  });
  if (!payment?.userId)
    throw new HttpError(409, "This payment isn't linked to a user yet");
  const result = await sendReceipt(id);
  await audit(c.get("userId"), "payment.receipt_resent", payment.userId, {
    receipt: receiptNumber(payment),
  });
  return c.json({ sent: result.sent });
});

/** Runs the Friday client-update job now (it skips boards already sent). */
adminRouter.post("/admin/jobs/weekly-updates", async (c) => {
  const results = await runWeeklyUpdates();
  await audit(c.get("userId"), "jobs.weekly_updates_run", null, {
    sent: results.filter((row) => row.status === "sent").length,
  });
  return c.json(results);
});

/** Every user as CSV, for spreadsheets or email tools. */
adminRouter.get("/admin/export/users.csv", async (c) => {
  const rows = await db
    .select({
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      source: users.signupSource,
      suspendedAt: users.suspendedAt,
      plan: subscriptions.plan,
      status: subscriptions.billingStatus,
      interval: subscriptions.billingInterval,
      paypal: sql<string | null>`coalesce(${subscriptions.dodoSubscriptionId}, ${subscriptions.paypalSubscriptionId})`,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .orderBy(desc(users.createdAt));
  // Quote every cell; prefix formula-looking values so spreadsheets don't
  // execute them.
  const cell = (value: unknown) => {
    let text =
      value instanceof Date ? value.toISOString() : String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = [
    "name",
    "email",
    "signed_up",
    "last_seen",
    "source",
    "effective_plan",
    "billing_status",
    "interval",
    "paying",
    "period_end",
    "suspended",
  ];
  const lines = rows.map((row) =>
    [
      row.name,
      row.email,
      row.createdAt,
      row.lastSeenAt,
      row.source || "direct",
      row.plan
        ? effectivePlan({
            plan: row.plan,
            billingStatus: row.status!,
            currentPeriodEnd: row.currentPeriodEnd,
          })
        : "free",
      row.status || "",
      row.interval || "",
      row.paypal && row.status === "active" ? "yes" : "no",
      row.currentPeriodEnd,
      row.suspendedAt ? "yes" : "no",
    ]
      .map(cell)
      .join(","),
  );
  await audit(c.get("userId"), "users.exported", null, { rows: rows.length });
  return c.body([header.join(","), ...lines].join("\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="danto-users-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

adminRouter.get("/admin/audit", async (c) => {
  const rows = await db
    .select({
      id: adminAuditLogs.id,
      action: adminAuditLogs.action,
      meta: adminAuditLogs.meta,
      createdAt: adminAuditLogs.createdAt,
      targetUserId: adminAuditLogs.targetUserId,
      adminEmail: sql<
        string | null
      >`(select email from users where id = ${adminAuditLogs.adminId})`,
      targetEmail: sql<
        string | null
      >`(select email from users where id = ${adminAuditLogs.targetUserId})`,
    })
    .from(adminAuditLogs)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(100);
  return c.json(rows);
});

/* ------------------------------------------------------------------ */
/* Discount codes                                                      */
/* ------------------------------------------------------------------ */

adminRouter.get("/admin/discounts", async (c) => {
  return c.json(
    await db
      .select()
      .from(discountCodes)
      .orderBy(sql`${discountCodes.createdAt} desc`),
  );
});

adminRouter.post("/admin/discounts", async (c) => {
  const input = await body(c, createDiscountSchema);
  const existing = await db.query.discountCodes.findFirst({
    where: eq(discountCodes.code, input.code),
  });
  if (existing) throw new HttpError(409, "That code already exists");
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
  await audit(c.get("userId"), "discount.created", null, {
    code: created.code,
    percentOff: created.percentOff,
  });
  return c.json(created, 201);
});

adminRouter.patch("/admin/discounts/:id", async (c) => {
  const input = await body(c, updateDiscountSchema);
  const [updated] = await db
    .update(discountCodes)
    .set({
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.maxRedemptions !== undefined
        ? { maxRedemptions: input.maxRedemptions }
        : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(discountCodes.id, c.req.param("id")))
    .returning();
  if (!updated) throw new HttpError(404, "Discount code not found");
  await audit(c.get("userId"), "discount.updated", null, {
    code: updated.code,
    ...input,
  });
  return c.json(updated);
});


/* ------------------------------------------------------------------ */
/* Feedback: bug reports and feature ideas, triaged by AI              */
/* ------------------------------------------------------------------ */

adminRouter.get("/admin/feedback", async (c) => {
  const rows = await db
    .select({
      id: userFeedback.id,
      kind: userFeedback.kind,
      message: userFeedback.message,
      page: userFeedback.page,
      status: userFeedback.status,
      ai: userFeedback.ai,
      createdAt: userFeedback.createdAt,
      userId: userFeedback.userId,
      userEmail: users.email,
      userName: users.name,
    })
    .from(userFeedback)
    .leftJoin(users, eq(users.id, userFeedback.userId))
    .orderBy(desc(userFeedback.createdAt))
    .limit(500);
  return c.json(rows);
});

adminRouter.patch("/admin/feedback/:id", async (c) => {
  const input = await body(
    c,
    z.object({ status: z.enum(["new", "planned", "done", "closed"]) }),
  );
  const [row] = await db
    .update(userFeedback)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(userFeedback.id, c.req.param("id")))
    .returning({ id: userFeedback.id, userId: userFeedback.userId });
  if (!row) throw new HttpError(404, "Feedback not found");
  await audit(c.get("userId"), "feedback.status", row.userId, {
    id: row.id,
    status: input.status,
  });
  return c.json({ ok: true });
});

adminRouter.post("/admin/feedback/:id/triage", async (c) => {
  if (!process.env.OPENAI_API_KEY)
    throw new HttpError(503, "AI is not configured yet");
  const triage = await triageFeedback(c.req.param("id"));
  if (!triage) throw new HttpError(502, "AI could not analyse this one. Try again.");
  return c.json(triage);
});

adminRouter.post("/admin/feedback/insights", async (c) => {
  const rows = await db
    .select({
      kind: userFeedback.kind,
      message: userFeedback.message,
      ai: userFeedback.ai,
    })
    .from(userFeedback)
    .where(inArray(userFeedback.status, ["new", "planned"]))
    .orderBy(desc(userFeedback.createdAt))
    .limit(200);
  if (!rows.length) throw new HttpError(400, "No open feedback to analyse yet");
  const insights = await feedbackInsights(
    rows.map((row) => ({
      kind: row.kind,
      message: row.message.slice(0, 600),
      area: row.ai?.area,
      severity: row.ai?.severity,
    })),
  );
  return c.json({ ...insights, analysed: rows.length });
});

export default adminRouter;
