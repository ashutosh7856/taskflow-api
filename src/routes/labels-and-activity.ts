import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { activityLogs, labels, users } from "../db/schema";
import { boardAccess, cardBoard } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { nameSchema } from "../validators/common";

const router = new Hono<AppEnv>();

router.get("/boards/:boardId/labels", async (c) => {
  const boardId = c.req.param("boardId");
  await boardAccess(c.get("userId"), boardId);
  return c.json(
    await db.select().from(labels).where(eq(labels.boardId, boardId)),
  );
});

router.post("/boards/:boardId/labels", async (c) => {
  const boardId = c.req.param("boardId");
  await boardAccess(c.get("userId"), boardId, true);
  const input = await body(c, nameSchema.extend({ color: z.string().min(1) }));
  const [label] = await db
    .insert(labels)
    .values({ ...input, boardId })
    .returning();
  return c.json(label, 201);
});

router.delete("/labels/:id", async (c) => {
  const labelId = c.req.param("id");
  const label = await db.query.labels.findFirst({
    where: eq(labels.id, labelId),
  });
  if (!label) throw new HttpError(404, "Label not found");

  await boardAccess(c.get("userId"), label.boardId, true);
  await db.delete(labels).where(eq(labels.id, labelId));
  return c.body(null, 204);
});

router.get("/boards/:boardId/activity", async (c) => {
  const boardId = c.req.param("boardId");
  await boardAccess(c.get("userId"), boardId);
  const rows = await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      boardId: activityLogs.boardId,
      cardId: activityLogs.cardId,
      meta: activityLogs.meta,
      createdAt: activityLogs.createdAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(activityLogs)
    .innerJoin(users, eq(activityLogs.userId, users.id))
    .where(eq(activityLogs.boardId, boardId))
    .orderBy(desc(activityLogs.createdAt));
  return c.json(rows);
});

router.get("/cards/:cardId/activity", async (c) => {
  const cardId = c.req.param("cardId");
  await cardBoard(c.get("userId"), cardId);
  const rows = await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      boardId: activityLogs.boardId,
      cardId: activityLogs.cardId,
      meta: activityLogs.meta,
      createdAt: activityLogs.createdAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(activityLogs)
    .innerJoin(users, eq(activityLogs.userId, users.id))
    .where(eq(activityLogs.cardId, cardId))
    .orderBy(desc(activityLogs.createdAt));
  return c.json(rows);
});

export default router;
