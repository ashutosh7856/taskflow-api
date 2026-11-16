import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { z } from "zod";

import { db } from "../db";
import { workspaces } from "../db/schema";
import { workspaceAccess } from "../lib/access";
import { body, HttpError, type AppEnv } from "../lib/http";
import { jwtSecret } from "../middleware/auth";
import { isAllowedOrigin } from "../lib/origins";
import { frontendUrl } from "../services/email";
import { ownerPlan, planCatalog } from "../services/entitlements";
import {
  defaultSlackEvents,
  isSlackWebhook,
  postToSlack,
  slackEventKeys,
} from "../services/slack";

/**
 * "Add to Slack" uses Slack OAuth with the incoming-webhook scope: the user
 * picks a channel and Slack returns a webhook URL for it. Needs
 * SLACK_CLIENT_ID and SLACK_CLIENT_SECRET; without them users can paste a
 * webhook URL instead.
 */
const slackClientId = () => process.env.SLACK_CLIENT_ID;
const slackClientSecret = () => process.env.SLACK_CLIENT_SECRET;
const callbackUrl = (requestUrl: string) =>
  `${new URL(requestUrl).origin}/slack/callback`;

async function workspaceWithPlan(workspaceId: string) {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const plan = await ownerPlan(workspace.ownerId);
  return { workspace, available: planCatalog[plan].slack };
}

function assertAvailable(available: boolean) {
  if (!available)
    throw new HttpError(402, "Slack notifications need the Pro plan", {
      upgradeRequired: true,
      requiredPlan: "pro",
    });
}

function status(workspace: typeof workspaces.$inferSelect, available: boolean) {
  return {
    available,
    oauth: Boolean(slackClientId() && slackClientSecret()),
    connected: Boolean(workspace.slackWebhookUrl),
    channel: workspace.slackChannel,
    team: workspace.slackTeam,
    events: workspace.slackEvents ?? defaultSlackEvents,
  };
}

export const slackRouter = new Hono<AppEnv>();

slackRouter.get("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId);
  const { workspace, available } = await workspaceWithPlan(workspaceId);
  return c.json(status(workspace, available));
});

slackRouter.post("/workspaces/:id/slack/connect", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const { available } = await workspaceWithPlan(workspaceId);
  assertAvailable(available);
  const clientId = slackClientId();
  if (!clientId) throw new HttpError(400, "Add to Slack isn't set up");
  const state = await sign(
    {
      purpose: "slack",
      workspaceId,
      userId: c.get("userId"),
      // Send them back to the address they started from (Pages or domain).
      returnTo: isAllowedOrigin(c.req.header("Origin"))
        ? c.req.header("Origin")
        : undefined,
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    jwtSecret(),
    "HS256",
  );
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  url.searchParams.set("state", state);
  return c.json({ url: url.toString() });
});

const settingsSchema = z.object({
  webhookUrl: z.string().trim().optional(),
  channel: z.string().trim().max(80).optional(),
  events: z.array(z.enum(slackEventKeys)).max(slackEventKeys.length).optional(),
});

slackRouter.put("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const input = await body(c, settingsSchema);
  const { workspace, available } = await workspaceWithPlan(workspaceId);
  assertAvailable(available);

  const changes: Partial<typeof workspaces.$inferInsert> = {};
  if (input.webhookUrl !== undefined) {
    if (!isSlackWebhook(input.webhookUrl))
      throw new HttpError(
        400,
        "That isn't a Slack webhook URL. It should start with https://hooks.slack.com/services/",
      );
    // Prove it works before saving it.
    const result = await postToSlack(input.webhookUrl, {
      text: `Danto is connected. Updates from “${workspace.name}” will post here.`,
    });
    if (!result.ok)
      throw new HttpError(
        400,
        `Slack rejected that webhook (${result.reason})`,
      );
    changes.slackWebhookUrl = input.webhookUrl;
    changes.slackChannel = input.channel || null;
    changes.slackTeam = null;
  }
  if (input.events) changes.slackEvents = input.events;
  if (Object.keys(changes).length) {
    await db
      .update(workspaces)
      .set(changes)
      .where(eq(workspaces.id, workspaceId));
  }
  const updated = await workspaceWithPlan(workspaceId);
  return c.json(status(updated.workspace, updated.available));
});

slackRouter.post("/workspaces/:id/slack/test", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  const { workspace, available } = await workspaceWithPlan(workspaceId);
  assertAvailable(available);
  if (!workspace.slackWebhookUrl)
    throw new HttpError(400, "Slack isn't connected");
  const result = await postToSlack(workspace.slackWebhookUrl, {
    text: `Test from Danto: “${workspace.name}” is connected to this channel.`,
  });
  if (result.gone) {
    await db
      .update(workspaces)
      .set({ slackWebhookUrl: null })
      .where(eq(workspaces.id, workspaceId));
  }
  if (!result.ok)
    throw new HttpError(
      400,
      result.gone
        ? "Slack says this connection was removed. Connect again."
        : `Slack didn't accept the message (${result.reason})`,
    );
  return c.json({ sent: true });
});

slackRouter.delete("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAccess(c.get("userId"), workspaceId, true);
  await db
    .update(workspaces)
    .set({ slackWebhookUrl: null, slackChannel: null, slackTeam: null })
    .where(eq(workspaces.id, workspaceId));
  const { workspace, available } = await workspaceWithPlan(workspaceId);
  return c.json(status(workspace, available));
});

/** Public: Slack redirects the browser here after "Add to Slack". */
export const slackCallback = new Hono<AppEnv>();

slackCallback.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  // Read the signed state first: it says where to send the person back to,
  // even when they cancelled on Slack's page.
  let payload: {
    purpose?: string;
    workspaceId?: string;
    userId?: string;
    returnTo?: string;
  } = {};
  let validState = false;
  if (state) {
    try {
      payload = (await verify(state, jwtSecret(), "HS256")) as typeof payload;
      validState = payload.purpose === "slack";
    } catch {
      /* expired or forged */
    }
  }
  const back = (result: string) =>
    c.redirect(
      validState && isAllowedOrigin(payload.returnTo)
        ? `${payload.returnTo!.replace(/\/$/, "")}/app?slack=${result}`
        : frontendUrl(`/app?slack=${result}`),
    );
  if (c.req.query("error")) return back("cancelled");
  if (!state || !validState) return back("expired");
  if (!code || !payload.workspaceId || !payload.userId) return back("error");
  try {
    await workspaceAccess(payload.userId, payload.workspaceId, true);
  } catch {
    return back("error");
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: slackClientId() || "",
      client_secret: slackClientSecret() || "",
      code,
      redirect_uri: callbackUrl(c.req.url),
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    team?: { name?: string };
    incoming_webhook?: { url?: string; channel?: string };
  };
  const webhookUrl = data.incoming_webhook?.url;
  if (!data.ok || !webhookUrl || !isSlackWebhook(webhookUrl)) {
    console.warn("Slack OAuth failed", { error: data.error });
    return back("error");
  }
  await db
    .update(workspaces)
    .set({
      slackWebhookUrl: webhookUrl,
      slackChannel: data.incoming_webhook?.channel || null,
      slackTeam: data.team?.name || null,
    })
    .where(eq(workspaces.id, payload.workspaceId));
  return back("connected");
});
