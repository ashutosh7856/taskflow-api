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
import { notifySlack, slackEscape } from "../services/slack";
import { emailClientBlocked, setCardApproval } from "./portal";

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
  /** Non-empty marks the card blocked; null or "" clears it. */
  blockedReason: z.string().trim().max(400).nullable().optional(),
  blockedOn: z.enum(["client", "team", "other"]).optional(),
  /** Why a late card is late; shown to the client. */
  delayReason: z.string().trim().max(400).nullable().optional(),
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
      columns: { id: true, name: true, role: true },
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

type CardRow = typeof cards.$inferSelect;

/**
 * Column changes for blocked / delayed status. Finishing a card clears both,
 * and moving the due date into the future clears the delay reason.
 */
export function blockerChanges(
  current: Pick<CardRow, "blockedReason" | "blockedOn" | "blockedAt" | "delayReason">,
  input: {
    blockedReason?: string | null;
    blockedOn?: "client" | "team" | "other";
    delayReason?: string | null;
    isCompleted?: boolean;
    dueDate?: Date | null;
  },
): Partial<Pick<CardRow, "blockedReason" | "blockedOn" | "blockedAt" | "delayReason">> {
  const out: Partial<Pick<CardRow, "blockedReason" | "blockedOn" | "blockedAt" | "delayReason">> = {};
  if (input.blockedReason !== undefined) {
    const reason = input.blockedReason?.trim() || null;
    out.blockedReason = reason;
    out.blockedOn = reason ? input.blockedOn || current.blockedOn || "team" : null;
    out.blockedAt = reason ? (current.blockedReason ? current.blockedAt : new Date()) : null;
  } else if (input.blockedOn && current.blockedReason) {
    out.blockedOn = input.blockedOn;
  }
  if (input.delayReason !== undefined)
    out.delayReason = input.delayReason?.trim() || null;
  if (input.isCompleted === true) {
    out.blockedReason = null;
    out.blockedOn = null;
    out.blockedAt = null;
    out.delayReason = null;
  }
  if (input.dueDate && input.dueDate.getTime() > Date.now() && input.delayReason === undefined)
    out.delayReason = null;
  return out;
}

/** Activity, owner email and client email when a card gets blocked. */
async function afterStatusChange(
  userId: string,
  boardId: string,
  before: CardRow,
  after: CardRow,
) {
  const blockedNow = !!after.blockedReason;
  const reasonChanged = blockedNow && after.blockedReason !== before.blockedReason;
  const onChanged = blockedNow && after.blockedOn !== before.blockedOn;
  if (blockedNow && (reasonChanged || onChanged)) {
    await recordActivity(userId, boardId, "card.blocked", after.id, {
      reason: after.blockedReason,
      on: after.blockedOn,
    });
    if (after.blockedOn === "client") {
      notifySlack({
        boardId,
        event: "client",
        actorId: userId,
        verb: `is waiting on the client (${slackEscape(after.blockedReason!)}) for`,
        cardId: after.id,
        cardTitle: after.title,
      });
      await emailClientBlocked(boardId, after);
    }
    await emailOwner(userId, boardId, after, `Blocked: ${after.title}`,
      `${after.blockedReason}`, "Card blocked");
  } else if (!blockedNow && before.blockedReason) {
    await recordActivity(userId, boardId, "card.unblocked", after.id);
  }
  if (after.delayReason && after.delayReason !== before.delayReason) {
    await recordActivity(userId, boardId, "card.delayed", after.id, {
      reason: after.delayReason,
    });
    await emailOwner(userId, boardId, after, `Running late: ${after.title}`,
      after.delayReason, "Delay noted");
  }
}

/** Email the workspace owner about a teammate's change (never themselves). */
async function emailOwner(
  actorId: string,
  boardId: string,
  card: CardRow,
  subject: string,
  message: string,
  eyebrow: string,
) {
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: { workspace: { columns: { ownerId: true } } },
  });
  const ownerId = board?.workspace.ownerId;
  if (!board || !ownerId || ownerId === actorId) return;
  const [owner, actor] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, ownerId) }),
    db.query.users.findFirst({ where: eq(users.id, actorId) }),
  ]);
  if (!owner) return;
  await sendEmail({
    to: owner.email,
    subject,
    title: card.title,
    eyebrow,
    message: `${actor?.name || "A teammate"}: ${message}`,
    details: [
      ["Board", board.name],
      ["Due", card.dueDate ? card.dueDate.toDateString() : "No due date"],
    ],
    actionLabel: "Open card",
    actionUrl: frontendUrl(`/boards/${boardId}?card=${card.id}`),
  });
}

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
  const { fields, blockedReason, blockedOn, delayReason, ...changes } = input;
  const status = blockerChanges(current, {
    blockedReason,
    blockedOn,
    delayReason,
    isCompleted: input.isCompleted,
    dueDate: input.dueDate,
  });
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
      ...status,
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
  await afterStatusChange(userId, currentBoardId, current, card);
  if (context && card.listId !== current.listId) {
    const roleOf = (id: string) =>
      context.lists.find((list) => list.id === id)?.role;
    const intoReview = roleOf(card.listId) === "review";
    const outOfReview = roleOf(current.listId) === "review";
    if (intoReview && card.approvalStatus !== "pending") {
      const board = await db.query.boards.findFirst({
        where: eq(boards.id, currentBoardId),
        columns: { portalEnabled: true },
      });
      if (board?.portalEnabled) {
        const result = await setCardApproval(
          userId,
          currentBoardId,
          cardId,
          "request",
        );
        if (result.card) Object.assign(card, result.card);
      }
    } else if (outOfReview && !intoReview && card.approvalStatus === "pending") {
      const result = await setCardApproval(userId, currentBoardId, cardId, "cancel");
      if (result.card) Object.assign(card, result.card);
    }
  }
  if (completionChanged && card.isCompleted) {
    const list = context?.lists.find((item) => item.id === card.listId);
    const doneName = list?.role === "done" ? list.name : null;
    notifySlack({
      boardId: currentBoardId,
      event: "done",
      actorId: userId,
      verb: doneName ? `moved to *${slackEscape(doneName)}*:` : "finished",
      cardId,
      cardTitle: card.title,
    });
  }
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
  if (targetUser && card)
    notifySlack({
      boardId,
      event: "assigned",
      actorId: c.get("userId"),
      verb:
        userId === c.get("userId")
          ? "took"
          : `assigned *${slackEscape(targetUser.name)}* to`,
      cardId,
      cardTitle: card.title,
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
