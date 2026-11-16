import { and, asc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  boards,
  cardLabels,
  cardMembers,
  cards,
  checklistItems,
  checklists,
  labels,
  lists,
  users,
} from "../db/schema";
import { getTemplate, mergeFields } from "../lib/templates";
import { boardAccess, cardBoard, listBoard } from "../lib/access";
import { purgeFiles } from "../services/storage";
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
  fields: z.record(z.string(), z.unknown()).optional(),
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
  clientVisible: z.boolean().optional(),
  /** Partial: only the keys sent change; null clears a field. */
  fields: z.record(z.string(), z.unknown()).optional(),
});

async function boardContext(boardId: string) {
  const [board, boardLists] = await Promise.all([
    db.query.boards.findFirst({
      where: eq(boards.id, boardId),
      columns: { template: true },
    }),
    db.query.lists.findMany({
      where: eq(lists.boardId, boardId),
      orderBy: asc(lists.position),
      columns: { id: true, role: true },
    }),
  ]);
  return { template: getTemplate(board?.template), lists: boardLists };
}

async function bottomPosition(listId: string) {
  const [{ highest }] = await db
    .select({ highest: max(cards.position) })
    .from(cards)
    .where(eq(cards.listId, listId));
  return Number(highest ?? -1) + 1;
}

cardsRouter.post("/lists/:listId/cards", async (c) => {
  const listId = c.req.param("listId");
  const userId = c.get("userId");
  const boardId = await listBoard(userId, listId);
  const input = await body(c, createCardSchema);
  const { labelIds = [], fields, ...cardInput } = input;
  const context = await boardContext(boardId);
  const inDoneList =
    context.lists.find((list) => list.id === listId)?.role === "done";
  const starter = context.template.categories.find(
    (category) => category.value === cardInput.category,
  )?.checklist;

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
  const cardId = crypto.randomUUID();
  const checklistId = crypto.randomUUID();
  // A card created in the done list (e.g. "Published") starts complete.
  const isCompleted = cardInput.isCompleted ?? (inDoneList || undefined);
  const [[card]] = await db.batch([
    db
      .insert(cards)
      .values({
        ...cardInput,
        isCompleted,
        id: cardId,
        listId,
        createdBy: userId,
        completedAt: isCompleted ? new Date() : null,
        position: cardInput.position ?? Number(highestPosition ?? -1) + 1,
        fields: fields
          ? mergeFields(context.template.id, null, fields)
          : undefined,
      })
      .returning(),
    ...[...new Set(labelIds)].map((labelId) =>
      db.insert(cardLabels).values({ cardId, labelId }),
    ),
    // Starter checklist for this kind of card (e.g. a social post).
    ...(starter
      ? [
          db.insert(checklists).values({
            id: checklistId,
            cardId,
            title: "Checklist",
          }),
          ...starter.map((title, position) =>
            db.insert(checklistItems).values({ checklistId, title, position }),
          ),
        ]
      : []),
  ]);

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

  const current = await db.query.cards.findFirst({
    where: eq(cards.id, cardId),
  });
  if (!current) throw new HttpError(404, "Card not found");
  const { fields, ...changes } = input;
  const needsBoard =
    fields !== undefined ||
    changes.isCompleted !== undefined ||
    (changes.listId !== undefined && changes.listId !== current.listId);
  const context = needsBoard ? await boardContext(currentBoardId) : null;

  // Keep "complete" and the done list (Published, Delivered…) in step, so
  // the list a card sits in and its status never disagree.
  if (context) {
    const roleOf = (id: string) =>
      context.lists.find((list) => list.id === id)?.role;
    const doneList = context.lists.find((list) => list.role === "done");
    const moving =
      changes.listId !== undefined && changes.listId !== current.listId;
    if (moving && changes.isCompleted === undefined) {
      if (roleOf(changes.listId!) === "done") changes.isCompleted = true;
      else if (roleOf(current.listId) === "done") changes.isCompleted = false;
    } else if (!moving && doneList && changes.isCompleted !== undefined) {
      if (changes.isCompleted && current.listId !== doneList.id) {
        changes.listId = doneList.id;
        changes.position = await bottomPosition(doneList.id);
      } else if (!changes.isCompleted && current.listId === doneList.id) {
        const doneIndex = context.lists.indexOf(doneList);
        const back = context.lists
          .slice(0, doneIndex)
          .reverse()
          .find((list) => list.role !== "review");
        if (back) {
          changes.listId = back.id;
          changes.position = await bottomPosition(back.id);
        }
      }
    }
  }
  const completionChanged =
    changes.isCompleted !== undefined &&
    changes.isCompleted !== current.isCompleted;
  if (changes.isCompleted !== undefined && !completionChanged)
    delete changes.isCompleted;

  const [card] = await db
    .update(cards)
    .set({
      ...changes,
      ...(completionChanged
        ? { completedAt: changes.isCompleted ? new Date() : null }
        : {}),
      ...(fields && context
        ? { fields: mergeFields(context.template.id, current.fields, fields) }
        : {}),
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
  await purgeFiles({ cardIds: [cardId] });
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
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
  });
  // Assigning yourself is not news; skip the email.
  const email =
    targetUser && userId !== c.get("userId")
      ? await sendEmail({
          to: targetUser.email,
          subject: `Assigned to you: ${card?.title || "a card"}`,
          title: card?.title || "A card was assigned to you",
          eyebrow: "New assignment",
          message: `${actor?.name || "A teammate"} assigned this to you.${card?.description ? `\n\n${card.description.slice(0, 280)}${card.description.length > 280 ? "…" : ""}` : ""}`,
          details: [
            ["Board", board?.name || "—"],
            [
              "Due",
              card?.dueDate ? card.dueDate.toDateString() : "No due date",
            ],
            ["Priority", card?.priority || "medium"],
          ],
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
