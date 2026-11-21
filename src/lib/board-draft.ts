import { z } from "zod";
import { getTemplate, templateIds, type ListRole } from "./templates";

/**
 * A board drafted by AI from a plain description ("track my team's sales and
 * tech work"). The user reviews it, then POST /workspaces/:id/boards creates
 * it with these lists, labels and starter cards.
 */
const roles = ["intake", "active", "review", "done"] as const;

export const LABEL_COLORS = [
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#111827",
] as const;

export const draftTaskSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().max(1200),
  priority: z.enum(["low", "medium", "high"]),
  category: z.string().min(1).max(40),
  dueOffsetDays: z.number().int().min(0).max(365),
  labels: z.array(z.string().max(40)).max(4),
});

export const boardDraftSchema = z.object({
  lists: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        role: z.enum(roles),
        tasks: z.array(draftTaskSchema).max(12),
      }),
    )
    .min(1)
    .max(8),
  labels: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    )
    .max(8),
});

export type BoardDraft = z.infer<typeof boardDraftSchema>;

export const aiBoardDraftSchema = boardDraftSchema.extend({
  name: z.string().trim().min(1).max(120),
  template: z.enum(templateIds),
  summary: z.string().max(400),
});

export const aiBoardDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "template", "summary", "lists", "labels"],
  properties: {
    name: { type: "string" },
    template: { type: "string", enum: templateIds },
    summary: { type: "string" },
    lists: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "tasks"],
        properties: {
          name: { type: "string" },
          role: { type: "string", enum: roles },
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
                "labels",
              ],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high"] },
                category: { type: "string" },
                dueOffsetDays: { type: "integer" },
                labels: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "color"],
        properties: {
          name: { type: "string" },
          color: { type: "string", enum: LABEL_COLORS },
        },
      },
    },
  },
};

const key = (value: string) => value.trim().toLowerCase();
// Models sometimes copy the role into the name: "Design [active]".
const ROLE_TAG = /\s*[[(](intake|active|review|done)[\])]\s*$/i;
const PRIORITY_LABEL = /^(high|medium|low|normal)( priority)?$|^priority$/;

/**
 * Makes any draft safe to create, whether it came from the AI or the browser:
 * unique list and label names, a sensible role order (work stages first, at
 * most one review step, one done list and only at the end), categories the
 * template knows, and card labels that exist on the board.
 */
export function normalizeDraft(
  draft: BoardDraft,
  templateId: string,
): BoardDraft {
  const template = getTemplate(templateId);
  const categories = template.categories.map((category) => category.value);

  const seenLists = new Set<string>();
  const lists = draft.lists
    .map((list) => ({
      ...list,
      name: list.name.replace(ROLE_TAG, "").trim() || list.name,
    }))
    .filter((list) => {
      const name = key(list.name);
      if (seenLists.has(name)) return false;
      seenLists.add(name);
      return true;
    });

  const lastIndex = lists.length - 1;
  let reviewSeen = false;
  const fixed = lists.map((list, index) => {
    let role: ListRole = list.role;
    if (role === "done" && index !== lastIndex) role = "active";
    if (role === "review" && (index === 0 || reviewSeen)) role = "active";
    if (role === "review") reviewSeen = true;
    if (role === "intake" && index !== 0) role = "active";
    return { ...list, role };
  });
  // Every board gets a stage where work happens and a Done list at the end,
  // so finishing a card always has somewhere to go.
  if (!fixed.some((list) => list.role === "active")) {
    const named = fixed.find((list) => key(list.name) === "in progress");
    if (named) named.role = "active";
    else {
      const at = fixed.findIndex((list) => list.role !== "intake");
      const doing = { name: "In progress", role: "active" as const, tasks: [] };
      if (at === -1) fixed.push(doing);
      else fixed.splice(at, 0, doing);
    }
  }
  if (fixed[fixed.length - 1].role !== "done" && fixed.length < 8) {
    const name = seenLists.has("done") ? "Finished" : "Done";
    fixed.push({ name, role: "done", tasks: [] });
  }

  // Labels that only repeat a stage or a priority add noise: cards already
  // show both.
  const stageNames = new Set(fixed.map((list) => key(list.name)));
  const seenLabels = new Set<string>();
  const labels = draft.labels.filter((label) => {
    const name = key(label.name);
    if (
      seenLabels.has(name) ||
      stageNames.has(name) ||
      PRIORITY_LABEL.test(name)
    )
      return false;
    seenLabels.add(name);
    return true;
  });

  // New boards start with open work only: cards drafted into approval or
  // done stages move to the last working stage, so the preview matches
  // what gets created.
  let lastWorking = -1;
  fixed.forEach((list, index) => {
    if (list.role === "intake" || list.role === "active") lastWorking = index;
  });
  const moved = fixed.flatMap((list) =>
    list.role === "review" || list.role === "done" ? list.tasks : [],
  );
  const placed = fixed.map((list, index) => ({
    ...list,
    tasks:
      list.role === "review" || list.role === "done"
        ? []
        : index === lastWorking
          ? [...list.tasks, ...moved]
          : list.tasks,
  }));

  return {
    labels,
    lists: placed.map((list) => ({
      ...list,
      tasks: list.tasks.map((task) => ({
        ...task,
        category: categories.includes(task.category)
          ? task.category
          : categories[0],
        labels: [...new Set(task.labels.map(key))]
          .filter((name) => seenLabels.has(name))
          .map(
            (name) => labels.find((label) => key(label.name) === name)!.name,
          ),
      })),
    })),
  };
}
