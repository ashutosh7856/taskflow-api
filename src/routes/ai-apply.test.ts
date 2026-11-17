import { describe, expect, test } from "bun:test";

import { mergePlan, normalizeTitle } from "./ai";

const task = (title: string) => ({
  title,
  description: "",
  priority: "medium" as const,
  category: "general",
  dueOffsetDays: null,
});


describe("AI plan apply", () => {
  const existing = [
    { id: "list-todo", name: "To do", position: 0, cards: [] },
    {
      id: "list-doing",
      name: "In progress",
      position: 1,
      cards: [{ title: "Write homepage copy", position: 0, isArchived: false }],
    },
  ];

  test("fills the template's empty list instead of adding a twin", () => {
    const plan = {
      lists: [
        { name: "To Do", tasks: [task("Collect brand assets"), task("Draft sitemap")] },
        { name: "in-progress", tasks: [task("Write homepage copy!"), task("Build header")] },
        { name: "QA", tasks: [task("Test forms")] },
      ],
    } as any;
    const { newLists, newCards, created } = mergePlan(plan, existing);
    expect(created).toEqual({ lists: 1, cards: 4, mergedLists: 2, skippedCards: 1 });
    expect(newLists.map((list) => [list.name, list.position])).toEqual([["QA", 2]]);
    const byTitle = Object.fromEntries(newCards.map((card) => [card.title, card]));
    expect(byTitle["Collect brand assets"].listId).toBe("list-todo");
    expect(byTitle["Draft sitemap"].position).toBe(1);
    // Added after the card already in "In progress"; the duplicate is skipped.
    expect(byTitle["Build header"]).toMatchObject({ listId: "list-doing", position: 1 });
    expect(byTitle["Write homepage copy!"]).toBeUndefined();
    expect(byTitle["Test forms"].listId).toBe(newLists[0].id);
  });

  test("dedupes repeated lists and tasks inside one plan", () => {
    const plan = {
      lists: [
        { name: "Review", tasks: [task("Client review")] },
        { name: "review", tasks: [task("Client Review"), task("Fix notes")] },
      ],
    } as any;
    const { created } = mergePlan(plan, []);
    expect(created).toEqual({ lists: 1, cards: 2, mergedLists: 1, skippedCards: 1 });
  });

  test("normalizes titles", () => {
    expect(normalizeTitle(" To-Do ")).toBe(normalizeTitle("TODO"));
  });
});
