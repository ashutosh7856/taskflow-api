import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { subscriptions, workspaces } from "../db/schema";
import { boardWorkspace } from "../lib/access";
import { HttpError } from "../lib/http";
import { planCatalog } from "./entitlements";

export function extractResponseText(response: any) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  throw new HttpError(502, "The AI service returned an empty response");
}

export async function workspaceAiAllowance(boardId: string) {
  const workspaceId = await boardWorkspace(boardId);
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  let subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, workspace.ownerId),
  });
  if (!subscription) {
    [subscription] = await db
      .insert(subscriptions)
      .values({ userId: workspace.ownerId })
      .returning();
  }
  const periodExpired =
    Date.now() - subscription.aiPeriodStart.getTime() >
    30 * 24 * 60 * 60 * 1000;
  if (periodExpired) {
    await db
      .update(subscriptions)
      .set({ aiRequestsThisMonth: 0, aiPeriodStart: new Date() })
      .where(eq(subscriptions.userId, subscription.userId));
    subscription.aiRequestsThisMonth = 0;
  }
  const limit = planCatalog[subscription.plan].aiRequests;
  if (subscription.aiRequestsThisMonth >= limit) {
    throw new HttpError(
      402,
      `AI limit reached for the ${subscription.plan} plan`,
      { limit, upgradeRequired: true },
    );
  }
  return { subscription, limit };
}

export async function openAiResponse(
  input: string,
  options?: { schema?: Record<string, unknown>; schemaName?: string },
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(503, "AI is not configured yet");
  const payload: Record<string, unknown> = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    input,
    max_output_tokens: 2500,
  };
  if (options?.schema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: options.schemaName || "taskflow_response",
        strict: true,
        schema: options.schema,
      },
    };
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("OpenAI request failed", response.status, data?.error?.type);
    throw new HttpError(502, "AI generation failed. Please try again.");
  }
  return extractResponseText(data);
}

export async function recordAiUse(userId: string, current: number) {
  await db
    .update(subscriptions)
    .set({ aiRequestsThisMonth: current + 1, updatedAt: new Date() })
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.aiRequestsThisMonth, current),
      ),
    );
}
