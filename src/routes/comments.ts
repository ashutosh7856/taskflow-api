import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { comments } from "../db/schema";
import { cardBoard } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";

const commentsRouter = new Hono<AppEnv>();

commentsRouter.get("/cards/:cardId/comments", async (c) => {
  const cardId = c.req.param("cardId");
  await cardBoard(c.get("userId"), cardId);

  const rows = await db.query.comments.findMany({
    where: eq(comments.cardId, cardId),
    orderBy: asc(comments.createdAt),
    with: { user: { columns: { passwordHash: false } } },
  });
  return c.json(rows);
});

commentsRouter.post("/cards/:cardId/comments", async (c) => {
  const cardId = c.req.param("cardId");
  const userId = c.get("userId");
  const boardId = await cardBoard(userId, cardId);
  const input = await body(c, z.object({ content: z.string().min(1) }));

  const [comment] = await db
    .insert(comments)
    .values({ ...input, cardId, userId })
    .returning();

  await recordActivity(userId, boardId, "comment.created", cardId, {
    commentId: comment.id,
  });
  return c.json(comment, 201);
});

commentsRouter.delete("/comments/:id", async (c) => {
  const commentId = c.req.param("id");
  const comment = await db.query.comments.findFirst({
    where: eq(comments.id, commentId),
  });
  if (!comment) throw new HttpError(404, "Comment not found");

  await cardBoard(c.get("userId"), comment.cardId);
  if (comment.userId !== c.get("userId")) {
    throw new HttpError(403, "Only the author can delete this comment");
  }

  await db.delete(comments).where(eq(comments.id, commentId));
  return c.body(null, 204);
});

export default commentsRouter;
