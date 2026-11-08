import { and, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { cardLabels, cardMembers, cards, labels, users } from "../db/schema";
import { boardAccess, cardBoard, listBoard } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";
import { frontendUrl, sendEmail } from "../services/email";

const cardsRouter = new Hono<AppEnv>();

const createCardSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  position: z.number().int().optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  category: z.string().min(1).max(40).default("task"),
  labelIds: z.array(z.string().uuid()).max(12).optional(),
  isCompleted: z.boolean().optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  position: z.number().int().optional(),
  listId: z.string().uuid().optional(),
  isArchived: z.boolean().optional(),
  isCompleted: z.boolean().optional(),
  category: z.string().min(1).max(40).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
});

cardsRouter.post("/lists/:listId/cards", async (c) => {
  const listId = c.req.param("listId");
  const userId = c.get("userId");
  const boardId = await listBoard(userId, listId);
  const input = await body(c, createCardSchema);
  const { labelIds = [], ...cardInput } = input;

  const [{ highestPosition }] = await db
    .select({ highestPosition: max(cards.position) })
    .from(cards)
    .where(eq(cards.listId, listId));

  if (labelIds.length) {
    const validLabels = await db.query.labels.findMany({
      where: (label, { and, eq, inArray }) =>
        and(eq(label.boardId, boardId), inArray(label.id, labelIds)),
    });
    if (validLabels.length !== new Set(labelIds).size) {
      throw new HttpError(
        400,
        "One or more labels do not belong to this board",
      );
    }
  }
  const card = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(cards)
      .values({
        ...cardInput,
        listId,
        createdBy: userId,
        completedAt: cardInput.isCompleted ? new Date() : null,
        position: cardInput.position ?? Number(highestPosition ?? -1) + 1,
      })
      .returning();
    if (labelIds.length) {
      await tx.insert(cardLabels).values(
        [...new Set(labelIds)].map((labelId) => ({
          cardId: created.id,
          labelId,
        })),
      );
    }
    return created;
  });

  await recordActivity(userId, boardId, "card.created", card.id);
  return c.json(card, 201);
});

cardsRouter.get("/cards/:id", async (c) => {
  const cardId = c.req.param("id");
  await cardBoard(c.get("userId"), cardId);

  const card = await db.query.cards.findFirst({
    where: eq(cards.id, cardId),
    with: {
      members: {
        with: { user: { columns: { passwordHash: false } } },
      },
      labels: { with: { label: true } },
      checklists: { with: { items: true } },
      comments: {
        with: { user: { columns: { passwordHash: false } } },
      },
    },
  });

  return c.json(card);
});

cardsRouter.patch("/cards/:id", async (c) => {
  const cardId = c.req.param("id");
  const userId = c.get("userId");
  const currentBoardId = await cardBoard(userId, cardId);
  const input = await body(c, updateCardSchema);

  if (input.listId) {
    const destinationBoardId = await listBoard(userId, input.listId);
    if (destinationBoardId !== currentBoardId) {
      throw new HttpError(400, "Cards cannot move between boards");
    }
  }

  const [card] = await db
    .update(cards)
    .set({
      ...input,
      ...(input.isCompleted === undefined
        ? {}
        : { completedAt: input.isCompleted ? new Date() : null }),
      updatedAt: new Date(),
    })
    .where(eq(cards.id, cardId))
    .returning();

  await recordActivity(userId, currentBoardId, "card.updated", cardId, input);
  return c.json(card);
});

cardsRouter.delete("/cards/:id", async (c) => {
  const cardId = c.req.param("id");
  const userId = c.get("userId");
  const boardId = await cardBoard(userId, cardId, true);

  await recordActivity(userId, boardId, "card.deleted", undefined, { cardId });
  await db.delete(cards).where(eq(cards.id, cardId));
  return c.body(null, 204);
});

cardsRouter.post("/cards/:id/members", async (c) => {
  const cardId = c.req.param("id");
  const boardId = await cardBoard(c.get("userId"), cardId);
  const { userId } = await body(c, z.object({ userId: z.string().uuid() }));

  await boardAccess(userId, boardId);
  await db.insert(cardMembers).values({ cardId, userId }).onConflictDoNothing();

  const [targetUser, card, actor] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.cards.findFirst({ where: eq(cards.id, cardId) }),
    db.query.users.findFirst({ where: eq(users.id, c.get("userId")) }),
  ]);
  const email = targetUser
    ? await sendEmail({
        to: targetUser.email,
        subject: `You were assigned: ${card?.title || "Danto card"}`,
        title: "A card was assigned to you",
        message: `${actor?.name || "A teammate"} assigned you to “${card?.title || "a card"}”.`,
        actionLabel: "Open card",
        actionUrl: frontendUrl(`/boards/${boardId}?card=${cardId}`),
      })
    : { sent: false };

  await recordActivity(c.get("userId"), boardId, "card.member_added", cardId, {
    assignedUserId: userId,
  });

  return c.json({ cardId, userId, emailSent: email.sent }, 201);
});

cardsRouter.delete("/cards/:id/members/:userId", async (c) => {
  const cardId = c.req.param("id");
  await cardBoard(c.get("userId"), cardId);

  await db
    .delete(cardMembers)
    .where(
      and(
        eq(cardMembers.cardId, cardId),
        eq(cardMembers.userId, c.req.param("userId")),
      ),
    );
  return c.body(null, 204);
});

cardsRouter.post("/cards/:id/labels", async (c) => {
  const cardId = c.req.param("id");
  const boardId = await cardBoard(c.get("userId"), cardId);
  const { labelId } = await body(c, z.object({ labelId: z.string().uuid() }));

  const label = await db.query.labels.findFirst({
    where: and(eq(labels.id, labelId), eq(labels.boardId, boardId)),
  });
  if (!label) {
    throw new HttpError(400, "Label does not belong to this board");
  }

  await db.insert(cardLabels).values({ cardId, labelId }).onConflictDoNothing();
  return c.json(label, 201);
});

cardsRouter.delete("/cards/:id/labels/:labelId", async (c) => {
  const cardId = c.req.param("id");
  await cardBoard(c.get("userId"), cardId);

  await db
    .delete(cardLabels)
    .where(
      and(
        eq(cardLabels.cardId, cardId),
        eq(cardLabels.labelId, c.req.param("labelId")),
      ),
    );
  return c.body(null, 204);
});

export default cardsRouter;
