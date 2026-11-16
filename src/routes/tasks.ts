import { and, eq, gte, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import {
  boardMembers,
  boards,
  cardMembers,
  cards,
  lists,
  workspaces,
} from "../db/schema";
import type { AppEnv } from "../lib/http";

const tasksRouter = new Hono<AppEnv>();

/**
 * "My tasks": every card assigned to the signed-in user, across all
 * workspaces and boards they can still open. Open cards plus anything
 * finished in the last 7 days.
 */
tasksRouter.get("/me/tasks", async (c) => {
  const userId = c.get("userId");
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      dueDate: cards.dueDate,
      priority: cards.priority,
      category: cards.category,
      isCompleted: cards.isCompleted,
      completedAt: cards.completedAt,
      approvalStatus: cards.approvalStatus,
      listId: lists.id,
      listName: lists.name,
      listRole: lists.role,
      boardId: boards.id,
      boardName: boards.name,
      boardTemplate: boards.template,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
    })
    .from(cardMembers)
    .innerJoin(cards, eq(cardMembers.cardId, cards.id))
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    // Only boards the user can still open.
    .innerJoin(
      boardMembers,
      and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId)),
    )
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(
      and(
        eq(cardMembers.userId, userId),
        eq(cards.isArchived, false),
        or(eq(cards.isCompleted, false), gte(cards.completedAt, weekAgo)),
      ),
    )
    .orderBy(sql`${cards.dueDate} is null`, cards.dueDate, cards.updatedAt)
    .limit(500);
  return c.json(rows);
});

export default tasksRouter;
