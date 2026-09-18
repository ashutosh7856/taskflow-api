import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  boardMembers,
  boards,
  cards,
  lists,
  workspaceMembers,
} from "../db/schema";
import { HttpError } from "./http";

export async function workspaceAccess(
  userId: string,
  workspaceId: string,
  requireManager = false,
) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.workspaceId, workspaceId),
    ),
  });

  if (!membership || (requireManager && membership.role === "member")) {
    throw new HttpError(403, "Workspace access denied");
  }
  return membership;
}

export async function boardAccess(
  userId: string,
  boardId: string,
  requireManager = false,
) {
  const membership = await db.query.boardMembers.findFirst({
    where: and(
      eq(boardMembers.userId, userId),
      eq(boardMembers.boardId, boardId),
    ),
  });

  if (!membership || (requireManager && membership.role === "member")) {
    throw new HttpError(403, "Board access denied");
  }
  return membership;
}

export async function listBoard(
  userId: string,
  listId: string,
  requireManager = false,
) {
  const [list] = await db
    .select({ boardId: lists.boardId })
    .from(lists)
    .where(eq(lists.id, listId))
    .limit(1);

  if (!list) throw new HttpError(404, "List not found");
  await boardAccess(userId, list.boardId, requireManager);
  return list.boardId;
}

export async function cardBoard(
  userId: string,
  cardId: string,
  requireManager = false,
) {
  const [card] = await db
    .select({ boardId: lists.boardId })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .where(eq(cards.id, cardId))
    .limit(1);

  if (!card) throw new HttpError(404, "Card not found");
  await boardAccess(userId, card.boardId, requireManager);
  return card.boardId;
}

export async function boardWorkspace(boardId: string) {
  const [board] = await db
    .select({ workspaceId: boards.workspaceId })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);

  if (!board) throw new HttpError(404, "Board not found");
  return board.workspaceId;
}
