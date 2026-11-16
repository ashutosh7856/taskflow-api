import { and, asc, desc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db, defer } from "../db";
import {
  boards,
  cards,
  clientFeedback,
  lists,
  users,
  workspaces,
} from "../db/schema";
import { boardAccess, cardBoard, workspaceAccess } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { cachedEdgeJson, invalidateEdge } from "../lib/cache";
import { clientFields, getTemplate } from "../lib/templates";
import { recordActivity } from "../services/activity";
import { notifySlack } from "../services/slack";
import { portalFiles } from "./files";
import {
  deliverClientUpdate,
  writeClientUpdate,
} from "../services/client-updates";
import { frontendUrl, sendEmail } from "../services/email";
import {
  assertPortalAvailable,
  ownerPlan,
  portalIsLive,
  planCatalog,
} from "../services/entitlements";

const portalUrl = (token: string) => frontendUrl(`/p/${token}`);

function newPortalToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// Best-effort per-instance limiter so a public link can't be used to spam
// the board owner's inbox. Serverless instances reset it, which is fine.
const hits = new Map<string, number[]>();
function rateLimit(c: Context, bucket: string, limit = 20, windowMs = 600_000) {
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit)
    throw new HttpError(429, "Too many submissions. Please try again later.");
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
}

async function portalBoard(token: string) {
  const board = await db.query.boards.findFirst({
    where: and(eq(boards.portalToken, token), eq(boards.portalEnabled, true)),
    with: { workspace: true },
  });
  if (!board) throw new HttpError(404, "This client portal is not available");
  return board;
}

async function notifyOwner(
  board: { id: string; name: string; workspace: { ownerId: string } },
  title: string,
  message: string,
  cardId?: string,
) {
  const owner = await db.query.users.findFirst({
    where: eq(users.id, board.workspace.ownerId),
  });
  if (!owner) return;
  await sendEmail({
    to: owner.email,
    subject: title,
    title,
    eyebrow: `Client portal · ${board.name}`,
    message,
    actionLabel: "Open the board",
    actionUrl: frontendUrl(
      `/boards/${board.id}${cardId ? `?card=${cardId}` : ""}`,
    ),
  });
}

/**
 * When a client answers on a card in the review stage, move it along:
 * approved goes to the next list (e.g. "Scheduled"), changes go back to the
 * last working list before review (e.g. "Drafting").
 */
async function nextStage(
  boardId: string,
  listId: string,
  kind: "approved" | "changes_requested",
) {
  const boardLists = await db.query.lists.findMany({
    where: eq(lists.boardId, boardId),
    orderBy: asc(lists.position),
    columns: { id: true, role: true },
  });
  const index = boardLists.findIndex((list) => list.id === listId);
  if (index < 0 || boardLists[index].role !== "review") return {};
  const target =
    kind === "approved"
      ? boardLists[index + 1]
      : boardLists
          .slice(0, index)
          .reverse()
          // Older boards' working lists have no role; treat them as active.
          .find((list) => list.role === "active" || !list.role);
  if (!target) return {};
  const [{ highest }] = await db
    .select({ highest: max(cards.position) })
    .from(cards)
    .where(eq(cards.listId, target.id));
  const done = target.role === "done";
  return {
    listId: target.id,
    position: Number(highest ?? -1) + 1,
    ...(done ? { isCompleted: true, completedAt: new Date() } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Public, unauthenticated client portal                               */
/* ------------------------------------------------------------------ */

export const publicPortal = new Hono<AppEnv>();

publicPortal.get("/:token", async (c) => {
  const token = c.req.param("token");
  // Shared edge cache: many client tabs polling the same portal cost one
  // set of DB reads per 20s instead of one per poll.
  const payload = await cachedEdgeJson(
    `portal:${token}`,
    20,
    async () => {
      const board = await portalBoard(token);
      if (!(await portalIsLive(board.workspace.ownerId, board.id)))
        throw new HttpError(
          404,
          "This portal is paused. Ask your project contact for an update.",
        );
      const plan = await ownerPlan(board.workspace.ownerId);
      const entitlements = planCatalog[plan];
      const workflow = getTemplate(board.template);
      const boardLists = await db.query.lists.findMany({
        where: eq(lists.boardId, board.id),
        orderBy: asc(lists.position),
        with: {
          cards: {
            where: and(
              eq(cards.isArchived, false),
              eq(cards.clientVisible, true),
            ),
            orderBy: asc(cards.position),
            with: { checklists: { with: { items: true } } },
          },
        },
      });
      const feedback = await db.query.clientFeedback.findMany({
        where: eq(clientFeedback.boardId, board.id),
        orderBy: desc(clientFeedback.createdAt),
        limit: 200,
      });
      const visibleCards = boardLists.flatMap((list) => list.cards);
      const files = await portalFiles(
        board.id,
        visibleCards.map((card) => card.id),
      );
      const now = Date.now();
      return {
        board: {
          name: board.name,
          clientName: board.portalClientName,
          welcome: board.portalWelcome,
          allowRequests: board.portalAllowRequests,
          updatedAt: new Date().toISOString(),
          workflow: {
            cardNoun: workflow.cardNoun,
            // The board's own finish list name wins ("Published", "Live"…).
            completed:
              boardLists.find((list) => list.role === "done")?.name ||
              workflow.wording.completed,
            due: workflow.wording.due,
            approve: workflow.wording.approve,
          },
        },
        brand: {
          name:
            (entitlements.portalBranding && board.workspace.brandName) ||
            board.workspace.name,
          color:
            (entitlements.portalBranding && board.workspace.brandColor) || null,
          logoUrl:
            (entitlements.portalBranding && board.workspace.brandLogoUrl) ||
            null,
          showBadge: !entitlements.whiteLabel,
        },
        stats: {
          total: visibleCards.length,
          completed: visibleCards.filter((card) => card.isCompleted).length,
          awaitingApproval: visibleCards.filter(
            (card) => card.approvalStatus === "pending",
          ).length,
          overdue: visibleCards.filter(
            (card) =>
              !card.isCompleted && card.dueDate && card.dueDate.getTime() < now,
          ).length,
        },
        lists: boardLists.map((list) => ({
          id: list.id,
          name: list.name,
          role: list.role,
          cards: list.cards.map((card) => {
            const items = card.checklists.flatMap(
              (checklist) => checklist.items,
            );
            return {
              id: card.id,
              title: card.title,
              description: card.description,
              category: card.category,
              dueDate: card.dueDate,
              isCompleted: card.isCompleted,
              completedAt: card.completedAt,
              approvalStatus: card.approvalStatus,
              approvalRequestedAt: card.approvalRequestedAt,
              fields: clientFields(board.template, card.fields),
              checklist: {
                done: items.filter((i) => i.isDone).length,
                total: items.length,
              },
              files: files.get(card.id) || [],
              feedback: feedback
                .filter((entry) => entry.cardId === card.id)
                .reverse()
                .map(({ id, kind, authorName, message, createdAt }) => ({
                  id,
                  kind,
                  authorName,
                  message,
                  createdAt,
                })),
            };
          }),
        })),
        requests: feedback
          .filter((entry) => entry.kind === "request")
          .slice(0, 20)
          .map(({ id, authorName, message, createdAt }) => ({
            id,
            authorName,
            message,
            createdAt,
          })),
      };
    },
    (promise) => defer(() => promise),
  );
  return c.json(payload);
});

publicPortal.post("/:token/cards/:cardId/respond", async (c) => {
  rateLimit(c, "portal-respond");
  const board = await portalBoard(c.req.param("token"));
  defer(() => invalidateEdge(`portal:${board.portalToken}`));
  const cardId = c.req.param("cardId");
  const input = await body(
    c,
    z.object({
      kind: z.enum(["approved", "changes_requested", "comment"]),
      authorName: z.string().trim().min(1).max(80),
      message: z.string().trim().max(4000).default(""),
    }),
  );
  if (input.kind !== "approved" && !input.message)
    throw new HttpError(400, "Please add a short message");
  const [card] = await db
    .select({ id: cards.id, title: cards.title, listId: cards.listId })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .where(
      and(
        eq(cards.id, cardId),
        eq(lists.boardId, board.id),
        eq(cards.clientVisible, true),
      ),
    )
    .limit(1);
  if (!card) throw new HttpError(404, "Item not found");

  const [entry] = await db
    .insert(clientFeedback)
    .values({
      boardId: board.id,
      cardId,
      kind: input.kind,
      authorName: input.authorName,
      message: input.message || "Approved",
    })
    .returning();
  if (input.kind !== "comment") {
    await db
      .update(cards)
      .set({
        approvalStatus: input.kind,
        approvalRespondedAt: new Date(),
        ...(await nextStage(board.id, card.listId, input.kind)),
        updatedAt: new Date(),
      })
      .where(eq(cards.id, cardId));
  }
  await recordActivity(
    board.workspace.ownerId,
    board.id,
    `client.${input.kind}`,
    cardId,
    { authorName: input.authorName },
  );
  notifySlack({
    boardId: board.id,
    event: "client",
    actorName: `${input.authorName} (client)`,
    verb:
      input.kind === "approved"
        ? "approved ✅"
        : input.kind === "changes_requested"
          ? "requested changes on ✏️"
          : "commented on",
    cardId,
    cardTitle: card.title,
    quote: input.message || undefined,
  });
  const verb =
    input.kind === "approved"
      ? "approved"
      : input.kind === "changes_requested"
        ? "requested changes on"
        : "commented on";
  defer(() =>
    notifyOwner(
      board,
      `${input.authorName} ${verb} “${card.title}”`,
      input.message ||
        `${input.authorName} approved this item in your client portal.`,
      cardId,
    ),
  );
  return c.json(entry, 201);
});

publicPortal.post("/:token/requests", async (c) => {
  rateLimit(c, "portal-request", 10);
  const board = await portalBoard(c.req.param("token"));
  defer(() => invalidateEdge(`portal:${board.portalToken}`));
  if (!board.portalAllowRequests)
    throw new HttpError(403, "Requests are turned off for this portal");
  const input = await body(
    c,
    z.object({
      authorName: z.string().trim().min(1).max(80),
      title: z.string().trim().min(3).max(180),
      details: z.string().trim().max(4000).default(""),
    }),
  );
  const firstList = await db.query.lists.findFirst({
    where: eq(lists.boardId, board.id),
    orderBy: asc(lists.position),
  });
  if (!firstList) throw new HttpError(409, "This board has no lists yet");
  const [{ highestPosition }] = await db
    .select({ highestPosition: max(cards.position) })
    .from(cards)
    .where(eq(cards.listId, firstList.id));
  const [card] = await db
    .insert(cards)
    .values({
      listId: firstList.id,
      title: input.title,
      description:
        `${input.details}\n\nRequested by ${input.authorName} via client portal.`.trim(),
      position: (highestPosition ?? -1) + 1,
      category:
        board.template === "operations" || board.template === "client"
          ? "request"
          : "task",
      createdBy: board.workspace.ownerId,
    })
    .returning();
  await db.insert(clientFeedback).values({
    boardId: board.id,
    cardId: card.id,
    kind: "request",
    authorName: input.authorName,
    message: input.title,
  });
  await recordActivity(
    board.workspace.ownerId,
    board.id,
    "client.request",
    card.id,
    { authorName: input.authorName },
  );
  notifySlack({
    boardId: board.id,
    event: "client",
    actorName: `${input.authorName} (client)`,
    verb: "sent a new request:",
    cardId: card.id,
    cardTitle: input.title,
    quote: input.details || undefined,
  });
  defer(() =>
    notifyOwner(
      board,
      `New request from ${input.authorName}: ${input.title}`,
      input.details || "A client submitted a new request through your portal.",
      card.id,
    ),
  );
  return c.json({ id: card.id }, 201);
});

/* ------------------------------------------------------------------ */
/* Authenticated portal management                                     */
/* ------------------------------------------------------------------ */

const portalAdmin = new Hono<AppEnv>();

async function portalSettings(boardId: string) {
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: { workspace: true },
  });
  if (!board) throw new HttpError(404, "Board not found");
  const plan = await ownerPlan(board.workspace.ownerId);
  const feedback = await db.query.clientFeedback.findMany({
    where: eq(clientFeedback.boardId, boardId),
    orderBy: desc(clientFeedback.createdAt),
    limit: 50,
  });
  const paused =
    board.portalEnabled &&
    !(await portalIsLive(board.workspace.ownerId, board.id));
  return {
    enabled: board.portalEnabled,
    paused,
    url: board.portalToken ? portalUrl(board.portalToken) : null,
    clientName: board.portalClientName,
    clientEmail: board.portalClientEmail,
    welcome: board.portalWelcome,
    allowRequests: board.portalAllowRequests,
    weeklyUpdates: board.portalWeeklyUpdates,
    lastAutoUpdateAt: board.portalLastAutoUpdateAt,
    plan,
    entitlements: {
      weeklyUpdates: planCatalog[plan].weeklyUpdates,
      clientPortals: planCatalog[plan].clientPortals,
      portalBranding: planCatalog[plan].portalBranding,
      whiteLabel: planCatalog[plan].whiteLabel,
    },
    unread: feedback.filter((entry) => !entry.readAt).length,
    feedback,
  };
}

portalAdmin.get("/boards/:id/portal", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);
  return c.json(await portalSettings(boardId));
});

portalAdmin.put("/boards/:id/portal", async (c) => {
  const boardId = c.req.param("id");
  const userId = c.get("userId");
  await boardAccess(userId, boardId, true);
  const input = await body(
    c,
    z.object({
      enabled: z.boolean(),
      clientName: z.string().trim().max(120).nullable().optional(),
      clientEmail: z
        .string()
        .trim()
        .email()
        .max(200)
        .nullable()
        .optional()
        .or(z.literal("")),
      welcome: z.string().trim().max(1200).nullable().optional(),
      allowRequests: z.boolean().optional(),
      weeklyUpdates: z.boolean().optional(),
    }),
  );
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
  });
  if (!board) throw new HttpError(404, "Board not found");
  if (input.enabled && !board.portalEnabled)
    await assertPortalAvailable(board.workspaceId, boardId);
  if (input.weeklyUpdates && !board.portalWeeklyUpdates) {
    const owner = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, board.workspaceId),
    });
    const plan = owner ? await ownerPlan(owner.ownerId) : "free";
    if (!planCatalog[plan].weeklyUpdates)
      throw new HttpError(
        402,
        "Automatic Friday updates are part of Pro. Upgrade to turn them on.",
        { upgradeRequired: true, requiredPlan: "pro" },
      );
  }
  if (board.portalToken) await invalidateEdge(`portal:${board.portalToken}`);
  await db
    .update(boards)
    .set({
      portalEnabled: input.enabled,
      portalToken: board.portalToken || newPortalToken(),
      ...(input.clientName !== undefined
        ? { portalClientName: input.clientName || null }
        : {}),
      ...(input.clientEmail !== undefined
        ? { portalClientEmail: input.clientEmail || null }
        : {}),
      ...(input.welcome !== undefined
        ? { portalWelcome: input.welcome || null }
        : {}),
      ...(input.allowRequests !== undefined
        ? { portalAllowRequests: input.allowRequests }
        : {}),
      ...(input.weeklyUpdates !== undefined
        ? { portalWeeklyUpdates: input.weeklyUpdates }
        : {}),
    })
    .where(eq(boards.id, boardId));
  await recordActivity(
    userId,
    boardId,
    input.enabled ? "portal.enabled" : "portal.disabled",
  );
  return c.json(await portalSettings(boardId));
});

portalAdmin.post("/boards/:id/portal/rotate", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId, true);
  const [previous] = await db
    .select({ token: boards.portalToken })
    .from(boards)
    .where(eq(boards.id, boardId));
  await db
    .update(boards)
    .set({ portalToken: newPortalToken() })
    .where(eq(boards.id, boardId));
  // The old link must stop working right away, not after the cache expires.
  if (previous?.token) await invalidateEdge(`portal:${previous.token}`);
  return c.json(await portalSettings(boardId));
});

portalAdmin.post("/boards/:id/portal/read", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);
  await db
    .update(clientFeedback)
    .set({ readAt: new Date() })
    .where(
      and(eq(clientFeedback.boardId, boardId), isNull(clientFeedback.readAt)),
    );
  return c.json({ ok: true });
});

portalAdmin.post("/cards/:id/approval", async (c) => {
  const cardId = c.req.param("id");
  const userId = c.get("userId");
  const boardId = await cardBoard(userId, cardId);
  const { action } = await body(
    c,
    z.object({ action: z.enum(["request", "cancel"]) }),
  );
  const [card] = await db
    .update(cards)
    .set(
      action === "request"
        ? {
            approvalStatus: "pending",
            approvalRequestedAt: new Date(),
            approvalRespondedAt: null,
            clientVisible: true,
            updatedAt: new Date(),
          }
        : { approvalStatus: "none", updatedAt: new Date() },
    )
    .where(eq(cards.id, cardId))
    .returning();
  await recordActivity(userId, boardId, `approval.${action}`, cardId);
  if (action === "request" && card)
    notifySlack({
      boardId,
      event: "client",
      actorId: userId,
      verb: "sent for client approval:",
      cardId,
      cardTitle: card.title,
    });
  const [portal] = await db
    .select({ token: boards.portalToken })
    .from(boards)
    .where(eq(boards.id, boardId));
  if (portal?.token) defer(() => invalidateEdge(`portal:${portal.token}`));

  let emailed = false;
  if (action === "request") {
    const board = await db.query.boards.findFirst({
      where: eq(boards.id, boardId),
      with: { workspace: true },
    });
    if (board?.portalEnabled && board.portalToken && board.portalClientEmail) {
      const sender = board.workspace.brandName || board.workspace.name;
      const plan = await ownerPlan(board.workspace.ownerId);
      const branded = planCatalog[plan].portalBranding;
      const result = await sendEmail({
        to: board.portalClientEmail,
        subject: `Ready for your review: ${card.title}`,
        title: card.title,
        eyebrow: "Approval requested",
        message: `${sender} has marked this as ready for your review. Take a look, then approve it or request changes. It takes one click, and you don't need an account.`,
        details: [
          ["Project", board.name],
          ["From", sender],
        ],
        brand: {
          name: sender,
          color: branded ? board.workspace.brandColor : null,
          logoUrl: branded ? board.workspace.brandLogoUrl : null,
        },
        showCredit: !planCatalog[plan].whiteLabel,
        actionLabel: "Review and approve",
        actionUrl: `${portalUrl(board.portalToken)}?card=${cardId}`,
      });
      emailed = result.sent;
    }
  }
  return c.json({ card, emailed });
});

portalAdmin.put("/workspaces/:id/branding", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(
    c,
    z.object({
      brandName: z.string().trim().max(80).nullable(),
      brandColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable(),
      brandLogoUrl: z
        .string()
        .trim()
        .url()
        .max(500)
        .nullable()
        .or(z.literal("")),
    }),
  );
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  if (!planCatalog[plan].portalBranding)
    throw new HttpError(402, "Custom portal branding requires the Pro plan", {
      upgradeRequired: true,
      requiredPlan: "pro",
    });
  const [updated] = await db
    .update(workspaces)
    .set({
      brandName: input.brandName || null,
      brandColor: input.brandColor || null,
      brandLogoUrl: input.brandLogoUrl || null,
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return c.json(updated);
});

/* AI client update: turn the live board into a client-ready status email. */

portalAdmin.post("/boards/:id/ai/client-update", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);
  const { tone } = await body(
    c,
    z.object({
      tone: z.enum(["friendly", "formal", "brief"]).default("friendly"),
    }),
  );
  const { board, update, reservation, limit, subscription } =
    await writeClientUpdate(boardId, tone);
  return c.json({
    ...update,
    to: board.portalClientEmail,
    portalUrl:
      board.portalEnabled && board.portalToken
        ? portalUrl(board.portalToken)
        : null,
    usage: { used: reservation.used, limit, plan: subscription.plan },
  });
});

portalAdmin.post("/boards/:id/client-update/send", async (c) => {
  const boardId = c.req.param("id");
  const userId = c.get("userId");
  await boardAccess(userId, boardId, true);
  const input = await body(
    c,
    z.object({
      to: z.string().trim().email(),
      subject: z.string().trim().min(1).max(160),
      body: z.string().trim().min(1).max(6000),
    }),
  );
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: { workspace: true },
  });
  if (!board) throw new HttpError(404, "Board not found");
  const plan = await ownerPlan(board.workspace.ownerId);
  if (plan === "free")
    throw new HttpError(
      402,
      "Sending client updates from Danto requires the Pro plan. Copy the text to send it yourself.",
      { upgradeRequired: true, requiredPlan: "pro" },
    );
  const result = await deliverClientUpdate(board, plan, input);
  if (!result.sent)
    throw new HttpError(502, result.reason || "The email could not be sent");
  await recordActivity(userId, boardId, "client.update_sent", undefined, {
    to: input.to,
  });
  return c.json({ sent: true });
});

/** First-run checklist for the dashboard: what has this account done yet? */
portalAdmin.get("/me/onboarding", async (c) => {
  const userId = c.get("userId");
  const [owned] = await db
    .select({
      boards: sql<number>`count(${boards.id})`,
      clientBoards: sql<number>`coalesce(sum(${boards.template} = 'client'), 0)`,
      portals: sql<number>`coalesce(sum(${boards.portalToken} is not null), 0)`,
    })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(eq(workspaces.ownerId, userId));
  const [approvals] = await db
    .select({ total: sql<number>`count(*)` })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(
      and(eq(workspaces.ownerId, userId), isNotNull(cards.approvalRequestedAt)),
    );
  const [clientActivity] = await db
    .select({ total: sql<number>`count(*)` })
    .from(clientFeedback)
    .innerJoin(boards, eq(clientFeedback.boardId, boards.id))
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(eq(workspaces.ownerId, userId));
  return c.json({
    createdBoard: owned.boards > 0,
    hasClientBoard: owned.clientBoards > 0,
    publishedPortal: owned.portals > 0,
    requestedApproval: approvals.total > 0,
    clientResponded: clientActivity.total > 0,
  });
});

export default portalAdmin;
