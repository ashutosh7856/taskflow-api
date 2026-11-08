import { asc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { boards, cards, lists } from "../db/schema";
import { boardAccess } from "../lib/access";
import { body, type AppEnv } from "../lib/http";
import { recordActivity } from "../services/activity";
import {
  openAiResponse,
  recordAiUse,
  workspaceAiAllowance,
} from "../services/openai";

const aiRouter = new Hono<AppEnv>();
const taskSchema = z.object({
  title: z.string().min(1).max(180),
  description: z.string().max(1200),
  priority: z.enum(["low", "medium", "high"]),
  category: z.string().min(1).max(40),
  dueOffsetDays: z.number().int().min(0).max(365),
});
const planSchema = z.object({
  projectName: z.string().min(1).max(120),
  overview: z.string().max(1200),
  lists: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        tasks: z.array(taskSchema).max(20),
      }),
    )
    .min(1)
    .max(8),
});
const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectName", "overview", "lists"],
  properties: {
    projectName: { type: "string" },
    overview: { type: "string" },
    lists: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "tasks"],
        properties: {
          name: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "title",
                "description",
                "priority",
                "category",
                "dueOffsetDays",
              ],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high"] },
                category: { type: "string" },
                dueOffsetDays: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
};
const workflowCategories = {
  blank: ["task", "milestone", "idea"],
  software: ["feature", "bug", "chore", "spike"],
  marketing: ["campaign", "content", "social", "email", "experiment"],
  operations: ["request", "incident", "process", "maintenance"],
} as const;
const executiveUpdateSchema = z.object({
  overallStatus: z.enum(["on_track", "at_risk", "off_track", "unknown"]),
  executiveSummary: z.string().min(1).max(1200),
  progressHighlights: z.array(z.string().min(1).max(300)).max(6),
  risks: z.array(z.string().min(1).max(300)).max(6),
  nextActions: z.array(z.string().min(1).max(300)).max(6),
});
const executiveUpdateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "overallStatus",
    "executiveSummary",
    "progressHighlights",
    "risks",
    "nextActions",
  ],
  properties: {
    overallStatus: {
      type: "string",
      enum: ["on_track", "at_risk", "off_track", "unknown"],
    },
    executiveSummary: { type: "string" },
    progressHighlights: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } },
  },
};

aiRouter.post("/boards/:id/ai/plan", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);
  const { prompt } = await body(
    c,
    z.object({ prompt: z.string().min(12).max(4000) }),
  );
  const { subscription, limit } = await workspaceAiAllowance(boardId);
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
  });
  const allowedCategories =
    workflowCategories[
      (board?.template || "blank") as keyof typeof workflowCategories
    ] || workflowCategories.blank;
  const text = await openAiResponse(
    `You are an expert delivery manager. Turn the request below into a concise, realistic execution board. Use 3-6 workflow lists and no more than 8 tasks per list. Tasks must be specific and actionable. This is a ${board?.template || "blank"} workflow. Every task category must be one of: ${allowedCategories.join(", ")}. Board: ${board?.name || "Untitled"}. Request: ${prompt}`,
    { schema: jsonSchema, schemaName: "project_plan" },
  );
  const plan = planSchema.parse(JSON.parse(text));
  const allowedCategorySet = new Set<string>(allowedCategories);
  for (const group of plan.lists) {
    for (const task of group.tasks) {
      if (!allowedCategorySet.has(task.category)) {
        task.category = allowedCategories[0];
      }
    }
  }
  await recordAiUse(subscription.userId, subscription.aiRequestsThisMonth);
  return c.json({
    plan,
    usage: {
      used: subscription.aiRequestsThisMonth + 1,
      limit,
      plan: subscription.plan,
    },
  });
});

aiRouter.post("/boards/:id/ai/apply", async (c) => {
  const boardId = c.req.param("id");
  const userId = c.get("userId");
  await boardAccess(userId, boardId, true);
  const plan = await body(c, planSchema);
  const [{ highestPosition }] = await db
    .select({ highestPosition: max(lists.position) })
    .from(lists)
    .where(eq(lists.boardId, boardId));
  let nextListPosition = Number(highestPosition ?? -1) + 1;
  const created = await db.transaction(async (tx) => {
    let cardCount = 0;
    for (const group of plan.lists) {
      const [list] = await tx
        .insert(lists)
        .values({ boardId, name: group.name, position: nextListPosition++ })
        .returning();
      if (group.tasks.length) {
        await tx.insert(cards).values(
          group.tasks.map((task, position) => ({
            listId: list.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            category: task.category,
            position,
            createdBy: userId,
            dueDate: task.dueOffsetDays
              ? new Date(Date.now() + task.dueOffsetDays * 86400000)
              : null,
          })),
        );
      }
      cardCount += group.tasks.length;
    }
    return { lists: plan.lists.length, cards: cardCount };
  });
  await recordActivity(userId, boardId, "ai.plan_applied", undefined, created);
  return c.json(created, 201);
});

aiRouter.get("/boards/:id/ai/summary", async (c) => {
  const boardId = c.req.param("id");
  await boardAccess(c.get("userId"), boardId);
  const { subscription, limit } = await workspaceAiAllowance(boardId);
  const board = await db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: {
      lists: {
        orderBy: asc(lists.position),
        with: {
          cards: {
            with: {
              labels: { with: { label: true } },
              checklists: { with: { items: true } },
              members: {
                with: { user: { columns: { passwordHash: false } } },
              },
            },
          },
        },
      },
    },
  });
  const now = new Date();
  const allCards = board?.lists.flatMap((list) => list.cards) || [];
  const activeCards = allCards.filter(
    (card) => !card.isArchived && !card.isCompleted,
  );
  const metrics = {
    total: allCards.filter((card) => !card.isArchived).length,
    completed: allCards.filter((card) => !card.isArchived && card.isCompleted)
      .length,
    active: activeCards.length,
    overdue: activeCards.filter(
      (card) => card.dueDate && card.dueDate.getTime() < now.getTime(),
    ).length,
    highPriority: activeCards.filter(
      (card) => card.priority === "high" || card.priority === "urgent",
    ).length,
  };
  const snapshot = board?.lists.map((list) => ({
    name: list.name,
    tasks: list.cards.map((card) => ({
      title: card.title,
      description: card.description,
      category: card.category,
      priority: card.priority,
      dueDate: card.dueDate,
      isCompleted: card.isCompleted,
      completedAt: card.completedAt,
      archived: card.isArchived,
      estimateMinutes: card.estimateMinutes,
      assignees: card.members.map((member) => member.user.name),
      labels: card.labels.map((entry) => entry.label.name),
      checklists: card.checklists.map((checklist) => ({
        title: checklist.title,
        completed: checklist.items.filter((item) => item.isDone).length,
        total: checklist.items.length,
      })),
    })),
  }));
  const text = await openAiResponse(
    `Create a concise executive project update using only the supplied board data. Explicitly account for completed tasks, active tasks, categories, priorities, due dates, overdue work, assignees, labels, estimates, and checklist progress when present. Do not infer that a task is complete merely because it is in the final list; use isCompleted. Do not invent facts. Every returned string must be plain prose without Markdown, asterisks, hyphen bullets, hashtags, or formatting symbols. If there is not enough evidence for risks or progress, return an empty array for that section. Current date: ${now.toISOString()}. Exact metrics: ${JSON.stringify(metrics)}. Board: ${board?.name || "Untitled"}. Workflow: ${board?.template || "blank"}. Board data: ${JSON.stringify(snapshot)}`,
    {
      schema: executiveUpdateJsonSchema,
      schemaName: "executive_project_update",
    },
  );
  const summary = executiveUpdateSchema.parse(JSON.parse(text));
  await recordAiUse(subscription.userId, subscription.aiRequestsThisMonth);
  return c.json({
    summary,
    document: {
      boardName: board?.name || "Untitled",
      generatedAt: now.toISOString(),
      metrics,
    },
    usage: {
      used: subscription.aiRequestsThisMonth + 1,
      limit,
      plan: subscription.plan,
    },
  });
});

export default aiRouter;
