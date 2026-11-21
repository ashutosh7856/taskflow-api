import { and, asc, eq, inArray, max } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  boardMembers,
  boards,
  cardLabels,
  cardMembers,
  cards,
  labels,
  lists,
  users,
  workspaceMembers,
} from "../db/schema";
import {
  boardAccess,
  boardWorkspace,
  listBoard,
  workspaceAccess,
} from "../lib/access";
import { invalidateEdge } from "../lib/cache";
import { getTemplate, templateIds } from "../lib/templates";
import { boardDraftSchema, normalizeDraft } from "../lib/board-draft";
import { mergePlan, normalizeTitle } from "./ai";
import { ensureListRoles } from "../services/list-roles";
import { purgeFiles } from "../services/storage";
import { body, HttpError, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";
import { frontendUrl, sendEmail } from "../services/email";
import {
  assertBoardCreationAvailable,
  assertCollaborationAvailable,
} from "../services/entitlements";
import { memberSchema, nameSchema } from "../validators/common";

const boardsRouter = new Hono<AppEnv>();
boardsRouter.get("/workspaces/:workspaceId/boards", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const userId = c.get("userId");
  await workspaceAccess(userId, workspaceId);

  const rows = await db
    .select({ board: boards, role: boardMembers.role })
    .from(boardMembers)
    .innerJoin(boards, eq(boardMembers.boardId, boards.id))
    .where(
      and(eq(boardMembers.userId, userId), eq(boards.workspaceId, workspaceId)),
    );

  return c.json(rows);
});

boardsRouter.post("/workspaces/:workspaceId/boards", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const userId = c.get("userId");
  await workspaceAccess(userId, workspaceId);

  const input = await body(
    c,
    nameSchema.extend({
      backgroundColor: z.string().min(1).default("blue"),
      template: z.enum(templateIds).default("blank"),
      /** An AI-drafted board the user reviewed; replaces the template's stages. */
      draft: boardDraftSchema.optional(),
    }),
  );
  await assertBoardCreationAvailable(workspaceId);
  const { template, draft: rawDraft, ...boardInput } = input;
  const draft = rawDraft ? normalizeDraft(rawDraft, template) : null;

  const boardId = crypto.randomUUID();
  const listRows = (draft?.lists ?? getTemplate(template).lists).map((list, position) => ({
    id: crypto.randomUUID(),
    boardId,
    name: list.name,
    role: list.role,
    position,
  }));
  const labelRows = (draft?.labels ?? getTemplate(template).labels).map((label) => ({
    id: crypto.randomUUID(),
    boardId,
    name: label.name,
    color: label.color,
  }));

  // Starter cards go through the same merge as the AI planner: deduped,
  // placed in working stages, and later stages never due before earlier ones.
  const cardRows: Array<ReturnType<typeof mergePlan>["newCards"][number] & { id: string }> = [];
  const cardLabelRows: Array<{ cardId: string; labelId: string }> = [];
  if (draft) {
    const { newCards } = mergePlan(
      {
        projectName: boardInput.name,
        overview: "",
        lists: draft.lists.map((list) => ({ name: list.name, tasks: list.tasks })),
      },
      listRows.map((list) => ({ ...list, cards: [] })),
    );
    const taskLabels = new Map(
      draft.lists.flatMap((list) =>
        list.tasks.map((task) => [normalizeTitle(task.title), task.labels] as const),
      ),
    );
    const labelId = new Map(labelRows.map((label) => [label.name, label.id]));
    for (const card of newCards) {
      const id = crypto.randomUUID();
      cardRows.push({ ...card, id });
      for (const name of taskLabels.get(normalizeTitle(card.title)) ?? []) {
        const match = labelId.get(name);
        if (match) cardLabelRows.push({ cardId: id, labelId: match });
      }
    }
  }

  // One row per statement keeps each under D1's 100 bound-parameter limit;
  // the batch commits them all or none.
  const [[board]] = await db.batch([
    db
      .insert(boards)
      .values({
        ...boardInput,
        id: boardId,
        template,
        workspaceId,
        createdBy: userId,
      })
      .returning(),
    db.insert(boardMembers).values({ boardId, userId, role: "owner" }),
    ...listRows.map((list) => db.insert(lists).values(list)),
    ...labelRows.map((label) => db.insert(labels).values(label)),
    ...cardRows.map((card) => db.insert(cards).values({ ...card, createdBy: userId })),
    ...cardLabelRows.map((row) => db.insert(cardLabels).values(row)),
  ]);
  if (draft)
    await recordActivity(userId, boardId, "ai.plan_applied", undefined, {
      lists: listRows.length,
      cards: cardRows.length,
    });

  return c.json(board, 201);
});

boardsRouter.get("/boards/:id", async (c) => {
  const boardId = c.req.param("id");
  const currentMembership = await boardAccess(c.get("userId"), boardId);
  await ensureListRoles(boardId);

  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: {
      members: {
        with: { user: { columns: { passwordHash: false } } },
      },
      labels: true,
      lists: {
        orderBy: asc(lists.position),
        with: {
          cards: {
            orderBy: asc(cards.position),
            with: {
              members: {
                with: { user: { columns: { passwordHash: false } } },
              },
              labels: { with: { label: true } },
              checklists: { with: { items: true } },
            },
          },
        },
      },
    },
  });

  if (!board) return c.json({ error: "Board not found" }, 404);

  const workspacePeople =
    currentMembership.role === "member"
      ? []
      : await db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.workspaceId, board.workspaceId),
          with: { user: { columns: { passwordHash: false } } },
        });

  return c.json({
    ...board,
    role: currentMembership.role,
    workspaceMembers: workspacePeople,
  });
});

boardsRouter.patch("/boards/:id", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId, true);

  const input = await body(
    c,
    nameSchema
      .partial()
      .extend({ backgroundColor: z.string().min(1).optional() }),
  );

  const [board] = await db
    .update(boards)
    .set(input)
    .where(eq(boards.id, boardId))
    .returning();

  return c.json(board);
});

boardsRouter.delete("/boards/:id", async (c) => {
  const boardId = c.req.param("id");
  const membership = await boardAccess(c.get("userId"), boardId);

  if (membership.role !== "owner") {
    throw new HttpError(403, "Only the owner can delete a board");
  }

  await purgeFiles({ boardId });
  const [deleted] = await db
    .delete(boards)
    .where(eq(boards.id, boardId))
    .returning({ portalToken: boards.portalToken });
  // The public portal is edge-cached; drop it so the link stops working now.
  if (deleted?.portalToken)
    await invalidateEdge(`portal:${deleted.portalToken}`);
  return c.body(null, 204);
});

boardsRouter.post("/boards/:id/members", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId, true);
  const input = await body(c, memberSchema);
  await assertCollaborationAvailable(await boardWorkspace(boardId));

  await workspaceAccess(input.userId, await boardWorkspace(boardId));

  const [membership] = await db
    .insert(boardMembers)
    .values({ ...input, boardId })
    .onConflictDoUpdate({
      target: [boardMembers.boardId, boardMembers.userId],
      set: { role: input.role },
    })
    .returning();

  const [targetUser, board, actor] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, input.userId) }),
    db.query.boards.findFirst({ where: eq(boards.id, boardId) }),
    db.query.users.findFirst({ where: eq(users.id, c.get("userId")) }),
  ]);
  const email = targetUser
    ? await sendEmail({
        to: targetUser.email,
        subject: `You were added to ${board?.name || "a board"}`,
        title: `You're on ${board?.name || "a new board"}`,
        eyebrow: "Board access",
        message: `${actor?.name || "A teammate"} added you to “${board?.name || "a board"}”. You can now see and update its cards.`,
        actionLabel: "Open board",
        actionUrl: frontendUrl(`/boards/${boardId}`),
      })
    : { sent: false };

  return c.json({ ...membership, emailSent: email.sent }, 201);
});

boardsRouter.delete("/boards/:id/members/:userId", async (c) => {
  const boardId = c.req.param("id");
  const userId = c.get("userId");
  const targetUserId = c.req.param("userId");
  await boardAccess(userId, boardId, true);

  const targetMembership = await db.query.boardMembers.findFirst({
    where: and(
      eq(boardMembers.boardId, boardId),
      eq(boardMembers.userId, targetUserId),
    ),
  });
  if (!targetMembership) throw new HttpError(404, "Board member not found");
  if (targetMembership.role === "owner") {
    throw new HttpError(400, "The board owner cannot be removed");
  }

  const boardCardIds = db
    .select({ id: cards.id })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .where(eq(lists.boardId, boardId));
  await db.batch([
    db
      .delete(cardMembers)
      .where(
        and(
          eq(cardMembers.userId, targetUserId),
          inArray(cardMembers.cardId, boardCardIds),
        ),
      ),
    db
      .delete(boardMembers)
      .where(
        and(
          eq(boardMembers.boardId, boardId),
          eq(boardMembers.userId, targetUserId),
        ),
      ),
  ]);

  await recordActivity(userId, boardId, "board.member_removed", undefined, {
    removedUserId: targetUserId,
  });

  return c.body(null, 204);
});

boardsRouter.post("/boards/:boardId/lists", async (c) => {
  const boardId = c.req.param("boardId");
  const userId = c.get("userId");
  await boardAccess(userId, boardId, true);

  const input = await body(
    c,
    nameSchema.extend({ position: z.number().int().optional() }),
  );
  const [{ highestPosition }] = await db
    .select({ highestPosition: max(lists.position) })
    .from(lists)
    .where(eq(lists.boardId, boardId));

  const [list] = await db
    .insert(lists)
    .values({
      ...input,
      boardId,
      position: input.position ?? Number(highestPosition ?? -1) + 1,
    })
    .returning();

  await recordActivity(userId, boardId, "list.created", undefined, {
    listId: list.id,
  });
  return c.json(list, 201);
});

boardsRouter.patch("/lists/:id", async (c) => {
  const listId = c.req.param("id");
  const userId = c.get("userId");
  const boardId = await listBoard(userId, listId, true);
  const input = await body(
    c,
    nameSchema.partial().extend({ position: z.number().int().optional() }),
  );

  const [list] = await db
    .update(lists)
    .set(input)
    .where(eq(lists.id, listId))
    .returning();

  await recordActivity(userId, boardId, "list.updated", undefined, { listId });
  return c.json(list);
});

boardsRouter.delete("/lists/:id", async (c) => {
  const listId = c.req.param("id");
  const userId = c.get("userId");
  const boardId = await listBoard(userId, listId, true);

  const listCards = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.listId, listId));
  await purgeFiles({ cardIds: listCards.map((card) => card.id) });
  await db.delete(lists).where(eq(lists.id, listId));
  await recordActivity(userId, boardId, "list.deleted", undefined, { listId });
  return c.body(null, 204);
});

export default boardsRouter;
