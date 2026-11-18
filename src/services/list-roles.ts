import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { cards, lists } from "../db/schema";

type Role = "intake" | "active" | "review" | "done";

const DONE = /\b(done|live|delivered|published|shipped|complete|completed|finished|launched|resolved|closed)\b/i;
const REVIEW = /\b(review|approval|approve|feedback|sign[- ]?off)\b/i;
const INTAKE = /\b(requests?|inbox|backlog|ideas?|to ?do|intake|briefs?|leads?|incoming|new)\b/i;

/**
 * Roles for a board made before list roles existed, guessed from list names
 * in board order. Returns null when it doesn't look like a workflow (no
 * done-like list), so custom boards are left alone.
 */
export function inferListRoles(names: string[]): Role[] | null {
  if (names.length < 2) return null;
  let done = -1;
  for (let i = names.length - 1; i >= 0; i -= 1)
    if (DONE.test(names[i])) {
      done = i;
      break;
    }
  if (done < 1) return null;
  return names.map((name, i) => {
    if (i === done) return "done";
    if (i > done) return "active";
    if (REVIEW.test(name)) return "review";
    if (i === 0 && INTAKE.test(name)) return "intake";
    return "active";
  });
}

/**
 * One-time upgrade for older boards: save inferred list roles, and tick the
 * cards already sitting in the done list (moving a card there does that now).
 */
export async function ensureListRoles(boardId: string) {
  const boardLists = await db
    .select({ id: lists.id, name: lists.name, role: lists.role })
    .from(lists)
    .where(eq(lists.boardId, boardId))
    .orderBy(asc(lists.position));
  if (boardLists.some((list) => list.role)) return false;
  const roles = inferListRoles(boardLists.map((list) => list.name));
  if (!roles) return false;
  for (const [index, list] of boardLists.entries())
    await db.update(lists).set({ role: roles[index] }).where(eq(lists.id, list.id));
  const doneIds = boardLists.filter((_, index) => roles[index] === "done").map((list) => list.id);
  await db
    .update(cards)
    .set({ isCompleted: true, completedAt: new Date() })
    .where(and(inArray(cards.listId, doneIds), eq(cards.isCompleted, false)));
  return true;
}
