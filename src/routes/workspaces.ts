import { and, eq, inArray, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import {
  boardMembers,
  boards,
  cardMembers,
  cards,
  lists,
  subscriptions,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { workspaceAccess } from "../lib/access";
import { invalidateEdge } from "../lib/cache";
import { purgeFiles } from "../services/storage";
import { body, HttpError, type AppEnv } from "../lib/http";
import { nameSchema, memberSchema } from "../validators/common";
import { frontendUrl, sendEmail } from "../services/email";
import {
  assertWorkspaceCreationAvailable,
  assertWorkspaceSeatAvailable,
} from "../services/entitlements";

const workspacesRouter = new Hono<AppEnv>();

workspacesRouter.get("/workspaces", async (c) => {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      ownerId: workspaces.ownerId,
      role: workspaceMembers.role,
      plan: subscriptions.plan,
      billingStatus: subscriptions.billingStatus,
      createdAt: workspaces.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .leftJoin(subscriptions, eq(subscriptions.userId, workspaces.ownerId))
    .where(eq(workspaceMembers.userId, c.get("userId")));

  return c.json(rows);
});

workspacesRouter.post("/workspaces", async (c) => {
  const input = await body(c, nameSchema);
  const userId = c.get("userId");
  await assertWorkspaceCreationAvailable(userId);

  const workspaceId = crypto.randomUUID();
  const [[workspace]] = await db.batch([
    db
      .insert(workspaces)
      .values({ ...input, id: workspaceId, ownerId: userId })
      .returning(),
    db.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" }),
  ]);

  return c.json(workspace, 201);
});

workspacesRouter.get("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await workspaceAccess(userId, workspaceId);

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    // The Slack webhook is a secret; GET /workspaces/:id/slack has the status.
    columns: { slackWebhookUrl: false },
    with: {
      members: {
        with: { user: { columns: { passwordHash: false } } },
      },
      boards: true,
    },
  });
  if (!workspace || membership.role !== "member") return c.json(workspace);

  // Members (e.g. a client invited to one board) only see the boards they
  // were added to, and only names of the other people.
  const mine = await db
    .select({ boardId: boardMembers.boardId })
    .from(boardMembers)
    .innerJoin(boards, eq(boardMembers.boardId, boards.id))
    .where(
      and(eq(boardMembers.userId, userId), eq(boards.workspaceId, workspaceId)),
    );
  const visible = new Set(mine.map((row) => row.boardId));
  return c.json({
    ...workspace,
    boards: workspace.boards.filter((board) => visible.has(board.id)),
    members: workspace.members.map((member) =>
      member.userId === userId
        ? member
        : {
            ...member,
            user: member.user && {
              id: member.user.id,
              name: member.user.name,
              avatarUrl: member.user.avatarUrl,
            },
          },
    ),
  });
});

/**
 * Everything that needs someone's attention across the boards you can see:
 * blocked work, late work (with the reason, if given), changes the client
 * asked for, and items waiting on the client. No AI, always current.
 */
workspacesRouter.get("/workspaces/:id/attention", async (c) => {
  const workspaceId = c.req.param("id");
  const userId = c.get("userId");
  const membership = await workspaceAccess(userId, workspaceId);
  const scope =
    membership.role === "member"
      ? and(
          eq(boards.workspaceId, workspaceId),
          inArray(
            boards.id,
            db
              .select({ id: boardMembers.boardId })
              .from(boardMembers)
              .where(eq(boardMembers.userId, userId)),
          ),
        )
      : eq(boards.workspaceId, workspaceId);
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      dueDate: cards.dueDate,
      approvalStatus: cards.approvalStatus,
      approvalRequestedAt: cards.approvalRequestedAt,
      approvalRespondedAt: cards.approvalRespondedAt,
      blockedReason: cards.blockedReason,
      blockedOn: cards.blockedOn,
      blockedAt: cards.blockedAt,
      delayReason: cards.delayReason,
      listName: lists.name,
      boardId: boards.id,
      boardName: boards.name,
    })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    .where(
      and(scope, eq(cards.isArchived, false), eq(cards.isCompleted, false)),
    );
  const now = Date.now();
  type Kind = "blocked" | "late" | "changes" | "waiting";
  const items = rows.flatMap((card) => {
    const late = !!card.dueDate && card.dueDate.getTime() < now;
    let kind: Kind | null = null;
    let reason: string | null = null;
    let since: Date | null = null;
    if (card.blockedReason && card.blockedOn !== "client") {
      [kind, reason, since] = ["blocked", card.blockedReason, card.blockedAt];
    } else if (late) {
      [kind, reason, since] = ["late", card.delayReason, card.dueDate];
    } else if (card.approvalStatus === "changes_requested") {
      [kind, since] = ["changes", card.approvalRespondedAt];
    } else if (card.blockedOn === "client" && card.blockedReason) {
      [kind, reason, since] = ["waiting", card.blockedReason, card.blockedAt];
    } else if (card.approvalStatus === "pending") {
      [kind, reason, since] = ["waiting", "Approval", card.approvalRequestedAt];
    }
    if (!kind) return [];
    return [
      {
        cardId: card.id,
        title: card.title,
        boardId: card.boardId,
        boardName: card.boardName,
        listName: card.listName,
        kind,
        reason,
        blockedOn: card.blockedOn,
        since,
        dueDate: card.dueDate,
        late,
        assignees: [] as string[],
      },
    ];
  });
  const ids = items.map((item) => item.cardId);
  if (ids.length) {
    const people = await db
      .select({ cardId: cardMembers.cardId, name: users.name })
      .from(cardMembers)
      .innerJoin(users, eq(cardMembers.userId, users.id))
      .where(inArray(cardMembers.cardId, ids.slice(0, 90)));
    for (const person of people)
      items.find((item) => item.cardId === person.cardId)?.assignees.push(person.name);
  }
  const order: Record<Kind, number> = { blocked: 0, late: 1, changes: 2, waiting: 3 };
  items.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.since?.getTime() ?? now) - (b.since?.getTime() ?? now),
  );
  const count = (kind: Kind) => items.filter((item) => item.kind === kind).length;
  return c.json({
    counts: {
      blocked: count("blocked"),
      late: count("late"),
      changes: count("changes"),
      waiting: count("waiting"),
    },
    items: items.slice(0, 100),
  });
});

workspacesRouter.patch("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(c, nameSchema);

  const [workspace] = await db
    .update(workspaces)
    .set(input)
    .where(eq(workspaces.id, workspaceId))
    .returning();

  const { slackWebhookUrl: _secret, ...visible } = workspace;
  return c.json(visible);
});

workspacesRouter.delete("/workspaces/:id", async (c) => {
  const workspaceId = c.req.param("id");
  const membership = await workspaceAccess(c.get("userId"), workspaceId);

  if (membership.role !== "owner") {
    throw new HttpError(403, "Only the owner can delete a workspace");
  }

  const portalBoards = await db
    .select({ portalToken: boards.portalToken })
    .from(boards)
    .where(eq(boards.workspaceId, workspaceId));
  await purgeFiles({ workspaceId });
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  // Boards cascade with the workspace; clear their cached public portals.
  await Promise.all(
    portalBoards
      .filter((board) => board.portalToken)
      .map((board) => invalidateEdge(`portal:${board.portalToken}`)),
  );
  return c.body(null, 204);
});

workspacesRouter.post("/workspaces/:id/members", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(c, memberSchema);
  const existingMember = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, input.userId),
    ),
  });
  if (!existingMember)
    await assertWorkspaceSeatAvailable(workspaceId, input.userId);

  const [membership] = await db
    .insert(workspaceMembers)
    .values({ ...input, workspaceId })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: input.role },
    })
    .returning();

  const [targetUser, workspace, actor] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, input.userId) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
    db.query.users.findFirst({ where: eq(users.id, c.get("userId")) }),
  ]);
  const email = targetUser
    ? await sendEmail({
        to: targetUser.email,
        subject: `You were added to ${workspace?.name || "a workspace"}`,
        title: `Welcome to ${workspace?.name || "the workspace"}`,
        eyebrow: "Workspace access",
        message: `${actor?.name || "A teammate"} added you to “${workspace?.name || "a workspace"}” on Danto.`,
        actionLabel: "Open workspace",
        actionUrl: frontendUrl("/app"),
      })
    : { sent: false };

  return c.json({ ...membership, emailSent: email.sent }, 201);
});

workspacesRouter.delete("/workspaces/:id/members/:userId", async (c) => {
  const workspaceId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const membership = await workspaceAccess(c.get("userId"), workspaceId, true);

  if (membership.role !== "owner" && targetUserId !== c.get("userId")) {
    throw new HttpError(403, "Access denied");
  }

  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
        or(
          eq(workspaceMembers.role, "admin"),
          eq(workspaceMembers.role, "member"),
        ),
      ),
    );

  return c.body(null, 204);
});

export default workspacesRouter;
