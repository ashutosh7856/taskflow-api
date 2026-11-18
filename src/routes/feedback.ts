import { and, count, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db, defer } from "../db";
import { userFeedback } from "../db/schema";
import { body, HttpError, type AppEnv } from "../lib/http";
import { triageFeedback } from "../services/feedback";

const feedbackRouter = new Hono<AppEnv>();

const createSchema = z.object({
  kind: z.enum(["bug", "feature"]),
  message: z.string().trim().min(10, "Tell us a bit more (at least 10 characters)").max(4000),
  page: z.string().trim().max(300).optional().nullable(),
});

const DAILY_LIMIT = 20;

feedbackRouter.post("/feedback", async (c) => {
  const userId = c.get("userId");
  const input = await body(c, createSchema);
  const [{ value: today }] = await db
    .select({ value: count() })
    .from(userFeedback)
    .where(
      and(
        eq(userFeedback.userId, userId),
        gte(userFeedback.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  if (today >= DAILY_LIMIT)
    throw new HttpError(429, "That's a lot of reports for one day. Please try again tomorrow.");
  const [row] = await db
    .insert(userFeedback)
    .values({ userId, kind: input.kind, message: input.message, page: input.page || null })
    .returning();
  defer(() => triageFeedback(row.id));
  return c.json({ id: row.id, kind: row.kind, status: row.status, createdAt: row.createdAt }, 201);
});

/** The signed-in user's own reports, newest first. */
feedbackRouter.get("/feedback", async (c) => {
  const rows = await db
    .select({
      id: userFeedback.id,
      kind: userFeedback.kind,
      message: userFeedback.message,
      status: userFeedback.status,
      createdAt: userFeedback.createdAt,
    })
    .from(userFeedback)
    .where(eq(userFeedback.userId, c.get("userId")))
    .orderBy(desc(userFeedback.createdAt))
    .limit(50);
  return c.json(rows);
});

export { feedbackRouter };
