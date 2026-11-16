import { and, count, eq, gte, sql } from "drizzle-orm";

import { db } from "../db";
import { aiUsageEvents, subscriptions, workspaces } from "../db/schema";
import { boardWorkspace } from "../lib/access";
import { HttpError } from "../lib/http";
import { effectivePlan, planCatalog } from "./entitlements";

export function extractResponseText(response: any) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  throw new HttpError(502, "The AI service returned an empty response");
}

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrousd: number;
};

export function estimateAiCostMicrousd(
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  const [inputRate, outputRate] = model.startsWith("gpt-6-luna")
    ? [0.1, 0.5]
    : model.startsWith("gpt-6.1-sol")
      ? [2, 10]
      : model.startsWith("gpt-4o-mini")
        ? [0.15, 0.6]
        : model.startsWith("gpt-4o")
          ? [2.5, 10]
          : [2.5, 10];
  return Math.ceil(inputTokens * inputRate + outputTokens * outputRate);
}

export function limitAiInput(input: string, maxCharacters = 60_000) {
  if (input.length <= maxCharacters) return input;
  return `${input.slice(0, maxCharacters)}\n[Context truncated to protect the workspace AI budget.]`;
}

type OpenAiResponseOptions = {
  schema?: Record<string, unknown>;
  schemaName?: string;
  reasoningEffort?: "none" | "low" | "medium";
  maxOutputTokens?: number;
};

export function supportsReasoningEffort(model: string) {
  return /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(model);
}

export function buildOpenAiPayload(
  model: string,
  input: string,
  options?: OpenAiResponseOptions,
) {
  const payload: Record<string, unknown> = {
    model,
    input: limitAiInput(input),
    max_output_tokens: options?.maxOutputTokens || 1800,
  };
  if (supportsReasoningEffort(model)) {
    payload.reasoning = { effort: options?.reasoningEffort || "low" };
  }
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
  return payload;
}

export async function workspaceAiAllowance(boardId: string) {
  const workspaceId = await boardWorkspace(boardId);
  return workspaceAiAllowanceForWorkspace(workspaceId);
}

export async function workspaceAiAllowanceForWorkspace(workspaceId: string) {
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
  const plan = effectivePlan(subscription);
  const limit = planCatalog[plan].aiRequests;
  if (limit !== null && subscription.aiRequestsThisMonth >= limit) {
    throw new HttpError(402, `AI limit reached for the ${plan} plan`, {
      limit,
      upgradeRequired: true,
    });
  }
  return { subscription: { ...subscription, plan }, limit };
}

export async function openAiResponse(
  input: string,
  options?: OpenAiResponseOptions,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(503, "AI is not configured yet");
  const primaryModel = process.env.OPENAI_MODEL || "gpt-6-luna";
  const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || "gpt-6.1-sol";
  const request = async (model: string) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildOpenAiPayload(model, input, options)),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => null);
    return { response, data, model };
  };
  let result;
  try {
    result = await request(primaryModel);
    if (
      !result.response.ok &&
      (result.response.status >= 429 ||
        result.response.status === 403 ||
        result.response.status === 404 ||
        result.data?.error?.param === "model") &&
      fallbackModel !== primaryModel
    ) {
      result = await request(fallbackModel);
    }
  } catch (error) {
    console.error(
      "OpenAI request error",
      error instanceof Error ? error.name : "unknown",
    );
    throw new HttpError(502, "AI generation timed out. Please try again.");
  }
  const { response, data, model } = result;
  if (!response.ok) {
    console.error("OpenAI request failed", {
      status: response.status,
      type: data?.error?.type,
      code: data?.error?.code,
      param: data?.error?.param,
    });
    throw new HttpError(502, "AI generation failed. Please try again.");
  }
  const inputTokens = Number(data?.usage?.input_tokens || 0);
  const outputTokens = Number(data?.usage?.output_tokens || 0);
  return {
    text: extractResponseText(data),
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostMicrousd: estimateAiCostMicrousd(
        model,
        inputTokens,
        outputTokens,
      ),
    } satisfies AiTokenUsage,
  };
}

export async function reserveAiRequest(
  userId: string,
  plan: keyof typeof planCatalog,
  feature: "board_plan" | "board_summary" | "workspace_pulse" | "client_update",
  inputCharacters = 0,
) {
  const limits = planCatalog[plan];
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // D1 has no row locks or interactive transactions. Checks run first, then
  // the usage event and the counter update are written in one atomic batch.
  const current = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });
  if (!current) throw new HttpError(404, "Subscription not found");
  const periodExpired =
    now.getTime() - current.aiPeriodStart.getTime() > 30 * 24 * 60 * 60 * 1000;
  const used = periodExpired ? 0 : current.aiRequestsThisMonth;
  const monthlyLimit = planCatalog[plan].aiRequests;
  if (monthlyLimit !== null && used >= monthlyLimit) {
    throw new HttpError(402, `AI limit reached for the ${plan} plan`, {
      limit: monthlyLimit,
      upgradeRequired: true,
    });
  }
  const [hourly, daily] = await Promise.all([
    db
      .select({ total: count() })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.userId, userId),
          gte(aiUsageEvents.createdAt, hourAgo),
        ),
      ),
    db
      .select({ total: count() })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.userId, userId),
          gte(aiUsageEvents.createdAt, dayAgo),
        ),
      ),
  ]);
  if (Number(hourly[0].total) >= limits.aiHourlyRequests) {
    throw new HttpError(
      429,
      "AI is being used too quickly. Try again in about an hour.",
      { retryAfterSeconds: 3600, fairUseLimit: limits.aiHourlyRequests },
    );
  }
  if (Number(daily[0].total) >= limits.aiDailyRequests) {
    throw new HttpError(
      429,
      "Daily AI fair-use limit reached. Try again tomorrow.",
      { retryAfterSeconds: 86400, fairUseLimit: limits.aiDailyRequests },
    );
  }
  const eventId = crypto.randomUUID();
  await db.batch([
    db.insert(aiUsageEvents).values({
      id: eventId,
      userId,
      feature,
      inputCharacters,
    }),
    db
      .update(subscriptions)
      .set({
        // Relative increment so two concurrent requests both count.
        aiRequestsThisMonth: periodExpired
          ? 1
          : sql`${subscriptions.aiRequestsThisMonth} + 1`,
        ...(periodExpired ? { aiPeriodStart: now } : {}),
        updatedAt: now,
      })
      .where(eq(subscriptions.userId, userId)),
  ]);
  return { eventId, used: used + 1 };
}

export async function recordAiUse(eventId: string, usage: AiTokenUsage) {
  await db
    .update(aiUsageEvents)
    .set(usage)
    .where(eq(aiUsageEvents.id, eventId));
}
