import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db";
import { boards, cards, lists, subscriptions, users, workspaces } from "../db/schema";
import { frontendUrl, sendEmail, type SendEmailInput } from "./email";

/**
 * Onboarding emails, sent by the daily cron. Each one goes to the users whose
 * account reached that point in the last 24 hours, so a user gets each email
 * once without a "sent" table (a missed cron day just skips that batch).
 */
const DAY = 86_400_000;

export type Progress = "no_portal" | "no_approval" | "done";

/** Day 2: nudge to the step they're stuck on. Null when they've done both. */
export function nudgeEmail(
  user: { name: string; email: string },
  progress: Progress,
): SendEmailInput | null {
  const first = user.name.split(" ")[0] || "there";
  if (progress === "done") return null;
  if (progress === "no_portal")
    return {
      to: user.email,
      subject: "Your client hasn't seen their portal yet",
      title: `${first}, your first portal is one click away`,
      eyebrow: "Getting started",
      message:
        "You signed up two days ago, but you haven't shared a client portal yet.\n\nIt's the part your client sees: what's done, what's next, and an Approve button. No login for them, no app.\n\nOpen any board, press “Share with client”, and send the link the next time they ask “any update?”.",
      details: [
        ["See what clients see", frontendUrl("/demo")],
        ["Takes", "About 2 minutes"],
      ],
      actionLabel: "Share my first portal",
      actionUrl: frontendUrl("/app"),
      footnote: "Stuck on something? Reply to this email and I'll help you set it up.",
    };
  return {
    to: user.email,
    subject: "Next step: get your first approval in writing",
    title: "Ask your client for their first approval",
    eyebrow: "Getting started",
    message:
      "Your portal is live. The moment it pays off is when your client taps Approve: you get notified, the item moves to done, and you have the approval in writing with a date.\n\nDrag a finished item into your review list (or open it and press “Ask client to approve”). Your client gets an email with a button.",
    actionLabel: "Request an approval",
    actionUrl: frontendUrl("/app"),
    footnote: "Questions? Just reply. A real person reads every one.",
  };
}

/** Three days before the free Pro trial ends. */
export function trialEndingEmail(
  user: { name: string; email: string },
  endsAt: Date,
): SendEmailInput {
  const first = user.name.split(" ")[0] || "there";
  const date = endsAt.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return {
    to: user.email,
    subject: `Your Danto Pro trial ends on ${date}`,
    title: `${first}, your Pro trial ends in 3 days`,
    eyebrow: "Your trial",
    message: `On ${date} your account moves to the Free plan. Nothing is deleted, and you won't be charged.\n\nOn Free, your first client portal stays live. Any others pause until you upgrade, and your branding and the AI Friday client updates switch off.\n\nIf Danto is saving you "any update?" emails, Pro keeps everything running for $19 a month, or $190 a year (2 months free).`,
    details: [
      ["Pro", "$19/month: unlimited portals, your branding, AI updates"],
      ["Yearly", "$190/year (2 months free)"],
    ],
    actionLabel: "Keep Pro",
    actionUrl: frontendUrl("/billing"),
    footnote: "Not for you? No action needed. Reply and tell me why, it really helps.",
  };
}

async function progressOf(userId: string): Promise<Progress> {
  const portals = await db
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(and(eq(workspaces.ownerId, userId), eq(boards.portalEnabled, true)))
    .limit(1);
  if (!portals.length) return "no_portal";
  const asked = await db
    .select({ id: cards.id })
    .from(cards)
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    .innerJoin(workspaces, eq(boards.workspaceId, workspaces.id))
    .where(and(eq(workspaces.ownerId, userId), isNotNull(cards.approvalRequestedAt)))
    .limit(1);
  return asked.length ? "done" : "no_approval";
}

export async function runLifecycleEmails(now = new Date()) {
  let sent = 0;
  const signedUp = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        gte(users.createdAt, new Date(now.getTime() - 3 * DAY)),
        lt(users.createdAt, new Date(now.getTime() - 2 * DAY)),
        isNull(users.suspendedAt),
      ),
    );
  for (const user of signedUp) {
    const email = nudgeEmail(user, await progressOf(user.id));
    if (email && (await sendEmail(email)).sent) sent += 1;
  }

  // Still on the free trial: no paid subscription was ever linked.
  const ending = await db
    .select({
      name: users.name,
      email: users.email,
      endsAt: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .innerJoin(users, eq(subscriptions.userId, users.id))
    .where(
      and(
        eq(subscriptions.plan, "pro"),
        eq(subscriptions.billingStatus, "cancelled"),
        isNull(subscriptions.dodoSubscriptionId),
        isNull(subscriptions.paypalSubscriptionId),
        gte(subscriptions.currentPeriodEnd, new Date(now.getTime() + 2 * DAY)),
        lt(subscriptions.currentPeriodEnd, new Date(now.getTime() + 3 * DAY)),
        isNull(users.suspendedAt),
      ),
    );
  for (const row of ending) {
    if (!row.endsAt) continue;
    if ((await sendEmail(trialEndingEmail(row, row.endsAt))).sent) sent += 1;
  }
  console.log("Lifecycle emails", { nudges: signedUp.length, trialEnding: ending.length, sent });
  return { nudges: signedUp.length, trialEnding: ending.length, sent };
}
