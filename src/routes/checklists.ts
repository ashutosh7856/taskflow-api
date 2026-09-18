import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { checklistItems, checklists } from "../db/schema";
import { cardBoard } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";

const checklistsRouter = new Hono<AppEnv>();

checklistsRouter.post("/cards/:cardId/checklists", async (c) => {
  const cardId = c.req.param("cardId");
  await cardBoard(c.get("userId"), cardId);
  const input = await body(c, z.object({ title: z.string().min(1) }));

  const [checklist] = await db
    .insert(checklists)
    .values({ ...input, cardId })
    .returning();
  return c.json(checklist, 201);
});

checklistsRouter.post("/checklists/:id/items", async (c) => {
  const checklistId = c.req.param("id");
  const checklist = await db.query.checklists.findFirst({
    where: eq(checklists.id, checklistId),
  });
  if (!checklist) throw new HttpError(404, "Checklist not found");

  await cardBoard(c.get("userId"), checklist.cardId);
  const input = await body(
    c,
    z.object({
      title: z.string().min(1),
      position: z.number().int().default(0),
    }),
  );

  const [item] = await db
    .insert(checklistItems)
    .values({ ...input, checklistId })
    .returning();
  return c.json(item, 201);
});

checklistsRouter.patch("/checklist-items/:id", async (c) => {
  const itemId = c.req.param("id");
  const item = await db.query.checklistItems.findFirst({
    where: eq(checklistItems.id, itemId),
    with: { checklist: true },
  });
  if (!item) throw new HttpError(404, "Item not found");

  await cardBoard(c.get("userId"), item.checklist.cardId);
  const input = await body(
    c,
    z.object({
      title: z.string().min(1).optional(),
      isDone: z.boolean().optional(),
      position: z.number().int().optional(),
    }),
  );

  const [updated] = await db
    .update(checklistItems)
    .set(input)
    .where(eq(checklistItems.id, itemId))
    .returning();
  return c.json(updated);
});

checklistsRouter.delete("/checklist-items/:id", async (c) => {
  const itemId = c.req.param("id");
  const item = await db.query.checklistItems.findFirst({
    where: eq(checklistItems.id, itemId),
    with: { checklist: true },
  });
  if (!item) throw new HttpError(404, "Item not found");

  await cardBoard(c.get("userId"), item.checklist.cardId);
  await db.delete(checklistItems).where(eq(checklistItems.id, itemId));
  return c.body(null, 204);
});

export default checklistsRouter;
