import { and, asc, eq, max, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  boardMembers,
  boards,
  cards,
  labels,
  lists,
  users,
} from "../db/schema";
import {
  boardAccess,
  boardWorkspace,
  listBoard,
  workspaceAccess,
} from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";
import { frontendUrl, sendEmail } from "../services/email";
import { memberSchema, nameSchema } from "../validators/common";

const boardsRouter = new Hono<AppEnv>();
const boardTemplates = {
  blank: [],
  software: ["Backlog", "Ready", "In progress", "Review", "Done"],
  marketing: ["Ideas", "Planned", "Creating", "Approval", "Published"],
  operations: ["Requests", "Triage", "In progress", "Blocked", "Resolved"],
} as const;
const templateLabels = {
  blank: [
    { name: "Important", color: "#dc2626" },
    { name: "Quick win", color: "#16a34a" },
  ],
  software: [
    { name: "Bug", color: "#dc2626" },
    { name: "Feature", color: "#2563eb" },
    { name: "Tech debt", color: "#7c3aed" },
    { name: "Blocked", color: "#111827" },
  ],
  marketing: [
    { name: "Social", color: "#db2777" },
    { name: "Email", color: "#7c3aed" },
    { name: "Content", color: "#0891b2" },
    { name: "Paid", color: "#ea580c" },
  ],
  operations: [
    { name: "Incident", color: "#dc2626" },
    { name: "Customer", color: "#2563eb" },
    { name: "Internal", color: "#16a34a" },
    { name: "Blocked", color: "#111827" },
  ],
} as const;

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
      template: z
        .enum(["blank", "software", "marketing", "operations"])
        .default("blank"),
    }),
  );
  const { template, ...boardInput } = input;

  const board = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(boards)
      .values({ ...boardInput, template, workspaceId, createdBy: userId })
      .returning();

    await tx.insert(boardMembers).values({
      boardId: created.id,
      userId,
      role: "owner",
    });
    const templateLists = boardTemplates[template];
    if (templateLists.length) {
      await tx.insert(lists).values(
        templateLists.map((name, position) => ({
          boardId: created.id,
          name,
          position,
        })),
      );
    }
    await tx.insert(labels).values(
      templateLabels[template].map((label) => ({
        ...label,
        boardId: created.id,
      })),
    );

    return created;
  });

  return c.json(board, 201);
});

boardsRouter.get("/boards/:id", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);

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

  return board ? c.json(board) : c.json({ error: "Board not found" }, 404);
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

  await db.delete(boards).where(eq(boards.id, boardId));
  return c.body(null, 204);
});

boardsRouter.post("/boards/:id/members", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId, true);
  const input = await body(c, memberSchema);

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
        title: "You have a new board",
        message: `${actor?.name || "A teammate"} added you to ${board?.name || "a board"} on TaskFlow.`,
        actionLabel: "Open board",
        actionUrl: frontendUrl(`/boards/${boardId}`),
      })
    : { sent: false };

  return c.json({ ...membership, emailSent: email.sent }, 201);
});

boardsRouter.delete("/boards/:id/members/:userId", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId, true);

  await db
    .delete(boardMembers)
    .where(
      and(
        eq(boardMembers.boardId, boardId),
        eq(boardMembers.userId, c.req.param("userId")),
        or(eq(boardMembers.role, "admin"), eq(boardMembers.role, "member")),
      ),
    );

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

  await db.delete(lists).where(eq(lists.id, listId));
  await recordActivity(userId, boardId, "list.deleted", undefined, { listId });
  return c.body(null, 204);
});

export default boardsRouter;
