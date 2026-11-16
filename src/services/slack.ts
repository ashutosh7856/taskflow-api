import { eq } from "drizzle-orm";

import { db, defer } from "../db";
import { boards, cards, users, workspaces } from "../db/schema";
import { frontendUrl } from "./email";
import { ownerPlan, planCatalog } from "./entitlements";

/**
 * Slack notifications through an incoming webhook per workspace. Messages
 * are sent after the response (defer), so Slack never slows the app down.
 */
export const slackEventKeys = [
  "assigned",
  "client",
  "done",
  "comments",
] as const;
export type SlackEvent = (typeof slackEventKeys)[number];
export const defaultSlackEvents: SlackEvent[] = ["assigned", "client", "done"];

/** Only Slack's own webhook host, so this can't be used to call other URLs. */
export function isSlackWebhook(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "hooks.slack.com" &&
      url.pathname.startsWith("/services/")
    );
  } catch {
    return false;
  }
}

/** Escapes text for Slack mrkdwn. */
export function slackEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Slack's answers when a webhook will never work again (app removed,
// channel deleted or archived). The connection is then cleared.
const deadWebhook = new Set([
  "no_service",
  "no_active_hooks",
  "channel_not_found",
  "channel_is_archived",
  "invalid_token",
  "team_disabled",
]);

export async function postToSlack(
  webhookUrl: string,
  message: { text: string; blocks?: unknown[] },
) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unfurl_links: false, ...message }),
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) return { ok: true, gone: false };
  const reason = (await response.text().catch(() => "")).trim();
  return {
    ok: false,
    gone:
      response.status === 404 ||
      response.status === 410 ||
      deadWebhook.has(reason),
    reason: reason || `HTTP ${response.status}`,
  };
}

export type SlackNotice = {
  boardId: string;
  event: SlackEvent;
  /** Who did it: a user id, or a name (e.g. the client's). */
  actorId?: string;
  actorName?: string;
  /** Text after the actor, e.g. "approved". Already mrkdwn-safe. */
  verb: string;
  cardId?: string;
  cardTitle?: string;
  /** Optional quote under the line (a comment, a request). */
  quote?: string;
};

export function slackMessage(
  notice: SlackNotice & { boardName: string; actor: string },
) {
  const link = notice.cardId
    ? frontendUrl(`/boards/${notice.boardId}?card=${notice.cardId}`)
    : frontendUrl(`/boards/${notice.boardId}`);
  const subject = notice.cardTitle
    ? ` <${link}|${slackEscape(notice.cardTitle)}>`
    : "";
  const line = `*${slackEscape(notice.actor)}* ${notice.verb}${subject}`;
  const quote = notice.quote
    ? `\n>${slackEscape(notice.quote.slice(0, 400)).replace(/\n/g, "\n>")}`
    : "";
  return {
    // Notification preview; mrkdwn too, so escaped like the rest.
    // (verb is already escaped by the caller).
    text: `${slackEscape(notice.actor)} ${notice.verb.replace(/\*/g, "")} ${slackEscape(notice.cardTitle || "")}`.trim(),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: line + quote } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${frontendUrl(`/boards/${notice.boardId}`)}|${slackEscape(notice.boardName)}> · Danto`,
          },
        ],
      },
    ],
  };
}

async function deliver(notice: SlackNotice) {
  const [row] = await db
    .select({
      boardName: boards.name,
      workspaceId: workspaces.id,
      ownerId: workspaces.ownerId,
      webhookUrl: workspaces.slackWebhookUrl,
      events: workspaces.slackEvents,
    })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(eq(boards.id, notice.boardId))
    .limit(1);
  if (!row?.webhookUrl) return;
  const events = row.events ?? defaultSlackEvents;
  if (!events.includes(notice.event)) return;
  if (!planCatalog[await ownerPlan(row.ownerId)].slack) return;

  let actor = notice.actorName;
  if (!actor && notice.actorId) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, notice.actorId),
      columns: { name: true },
    });
    actor = user?.name;
  }
  let cardTitle = notice.cardTitle;
  if (!cardTitle && notice.cardId) {
    const card = await db.query.cards.findFirst({
      where: eq(cards.id, notice.cardId),
      columns: { title: true },
    });
    cardTitle = card?.title;
  }
  const result = await postToSlack(
    row.webhookUrl,
    slackMessage({
      ...notice,
      cardTitle,
      boardName: row.boardName,
      actor: actor || "Someone",
    }),
  );
  if (result.gone) {
    await db
      .update(workspaces)
      .set({ slackWebhookUrl: null })
      .where(eq(workspaces.id, row.workspaceId));
  } else if (!result.ok) {
    console.warn("Slack post failed", { reason: result.reason });
  }
}

/** Posts to the board's workspace Slack channel, if one is connected. */
export function notifySlack(notice: SlackNotice) {
  return defer(() => deliver(notice));
}
