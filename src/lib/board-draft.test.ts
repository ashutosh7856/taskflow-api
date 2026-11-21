import { describe, expect, test } from "bun:test";

import {
  boardDraftSchema,
  normalizeDraft,
  type BoardDraft,
} from "./board-draft";

const task = (
  title: string,
  extra: Partial<BoardDraft["lists"][number]["tasks"][number]> = {},
) => ({
  title,
  description: "",
  priority: "medium" as const,
  category: "task",
  dueOffsetDays: 0,
  labels: [],
  ...extra,
});

describe("AI board drafts", () => {
  test("fixes role order: one intake first, one review, done only at the end", () => {
    const draft = normalizeDraft(
      {
        labels: [],
        lists: [
          { name: "Review", role: "review", tasks: [] },
          { name: "Backlog", role: "intake", tasks: [] },
          { name: "Done", role: "done", tasks: [] },
          { name: "Approval", role: "review", tasks: [] },
          { name: "Second review", role: "review", tasks: [] },
          { name: "Shipped", role: "done", tasks: [] },
        ],
      },
      "blank",
    );
    expect(draft.lists.map((list) => list.role)).toEqual([
      "active",
      "active",
      "active",
      "review",
      "active",
      "done",
    ]);
  });

  test("a board always has a working stage and ends in Done", () => {
    const onlyDone = normalizeDraft(
      { labels: [], lists: [{ name: "Done", role: "done", tasks: [] }] },
      "blank",
    );
    expect(onlyDone.lists.map((list) => [list.name, list.role])).toEqual([
      ["In progress", "active"],
      ["Done", "done"],
    ]);
    const noDone = normalizeDraft(
      {
        labels: [],
        lists: [
          { name: "Ideas", role: "intake", tasks: [] },
          { name: "In Progress", role: "intake", tasks: [] },
        ],
      },
      "blank",
    );
    expect(noDone.lists.map((list) => [list.name, list.role])).toEqual([
      ["Ideas", "intake"],
      ["In Progress", "active"],
      ["Done", "done"],
    ]);
  });

  test("drops duplicate lists and labels, keeps card labels that exist", () => {
    const draft = normalizeDraft(
      {
        labels: [
          { name: "Sales", color: "#2563eb" },
          { name: "sales ", color: "#dc2626" },
          { name: "Tech", color: "#16a34a" },
        ],
        lists: [
          {
            name: "To do",
            role: "intake",
            tasks: [task("Call leads", { labels: ["SALES", "Ghost"] })],
          },
          { name: "to do", role: "active", tasks: [] },
          { name: "Done", role: "done", tasks: [] },
        ],
      },
      "blank",
    );
    expect(draft.labels.map((label) => label.name)).toEqual(["Sales", "Tech"]);
    // The duplicate "to do" goes; a working stage is added before Done.
    expect(draft.lists.map((list) => list.name)).toEqual([
      "To do",
      "In progress",
      "Done",
    ]);
    expect(draft.lists[0].tasks[0].labels).toEqual(["Sales"]);
  });

  test("replaces categories the template doesn't know", () => {
    const draft = normalizeDraft(
      {
        labels: [],
        lists: [
          {
            name: "Doing",
            role: "active",
            tasks: [task("Fix login", { category: "nonsense" })],
          },
        ],
      },
      "operations",
    );
    expect(draft.lists[0].tasks[0].category).toBe("request");
  });

  test("rejects bad label colours from the browser", () => {
    const result = boardDraftSchema.safeParse({
      labels: [{ name: "X", color: "red;}" }],
      lists: [{ name: "Doing", role: "active", tasks: [] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("AI board draft cleanup", () => {
  test("drops labels that repeat a stage or priority, moves review/done cards to work", () => {
    const draft = normalizeDraft(
      {
        labels: [
          { name: "Published", color: "#2563eb" },
          { name: "High Priority", color: "#dc2626" },
          { name: "Client B", color: "#16a34a" },
        ],
        lists: [
          { name: "Ideas", role: "intake", tasks: [task("Brainstorm")] },
          { name: "Drafting", role: "active", tasks: [task("Draft post")] },
          {
            name: "Approval",
            role: "review",
            tasks: [task("Send post", { labels: ["Client B"] })],
          },
          {
            name: "Published",
            role: "done",
            tasks: [task("Publish post", { labels: ["Published"] })],
          },
        ],
      },
      "social",
    );
    expect(draft.labels.map((label) => label.name)).toEqual(["Client B"]);
    expect(draft.lists.map((list) => list.tasks.map((t) => t.title))).toEqual([
      ["Brainstorm"],
      ["Draft post", "Send post", "Publish post"],
      [],
      [],
    ]);
    expect(draft.lists[1].tasks[1].labels).toEqual(["Client B"]);
    expect(draft.lists[1].tasks[2].labels).toEqual([]);
  });
});

test("strips role tags the model copied into list names", () => {
  const draft = normalizeDraft(
    {
      labels: [],
      lists: [
        { name: "Discovery [intake]", role: "intake", tasks: [] },
        { name: "Design (active)", role: "active", tasks: [] },
        { name: "Done", role: "done", tasks: [] },
      ],
    },
    "website",
  );
  expect(draft.lists.map((list) => list.name)).toEqual([
    "Discovery",
    "Design",
    "Done",
  ]);
});
