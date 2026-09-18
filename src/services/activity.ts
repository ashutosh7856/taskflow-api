import { db } from "../db";
import { activityLogs } from "../db/schema";

export function recordActivity(
  userId: string,
  boardId: string,
  action: string,
  cardId?: string,
  meta?: unknown,
) {
  return db.insert(activityLogs).values({
    userId,
    boardId,
    cardId,
    action,
    meta,
  });
}
