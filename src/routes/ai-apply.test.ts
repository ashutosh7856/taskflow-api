import { describe, expect, test } from "bun:test";

import { alignPlan, hasTimeline, mergePlan, normalizeTitle } from "./ai";

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

  test("template boards: fills their own working lists, never review or done", () => {
    const staged = [
      { id: "disc", name: "Discovery & content", position: 0, role: "intake" as const, cards: [] },
      { id: "design", name: "Design", position: 1, role: "active" as const, cards: [] },
      { id: "build", name: "Build", position: 2, role: "active" as const, cards: [] },
      { id: "review", name: "Client review", position: 3, role: "review" as const, cards: [] },
      { id: "live", name: "Live", position: 4, role: "done" as const, cards: [] },
    ];
    const dated = (title: string, days: number) => ({ ...task(title), dueOffsetDays: days });
    const plan = {
      lists: [
        { name: "Discovery", tasks: [dated("Gather menu photos", 20)] },
        { name: "Designs", tasks: [dated("Homepage mockup", 5)] },
        { name: "Development", tasks: [task("Build booking form")] },
        { name: "Client review", tasks: [task("Present site to client")] },
        { name: "Live", tasks: [task("Launch")] },
      ],
    } as any;
    const { newLists, newCards } = mergePlan(plan, staged);
    expect(newLists).toEqual([]);
    const where = Object.fromEntries(newCards.map((card) => [card.title, card.listId]));
    expect(where).toEqual({
      "Gather menu photos": "disc",
      "Homepage mockup": "design",
      "Build booking form": "build",
      "Present site to client": "build",
      Launch: "build",
    });
    const due = Object.fromEntries(newCards.map((card) => [card.title, card.dueDate?.getTime()]));
    // Design was due before discovery; it's moved up so stages stay in order.
    expect(due["Homepage mockup"]!).toBeGreaterThanOrEqual(due["Gather menu photos"]!);
  });

  test("preview is regrouped into the board's own lists", () => {
    const staged = [
      { id: "ideas", name: "Ideas", position: 0, role: "intake" as const, cards: [] },
      { id: "draft", name: "Drafting", position: 1, role: "active" as const, cards: [] },
      { id: "ok", name: "Client approval", position: 2, role: "review" as const, cards: [] },
      { id: "sched", name: "Scheduled", position: 3, role: "active" as const, cards: [] },
      { id: "pub", name: "Published", position: 4, role: "done" as const, cards: [] },
    ];
    const plan = {
      projectName: "x",
      overview: "",
      lists: [
        { name: "Backlog", tasks: [task("Reel idea")] },
        { name: "Writing", tasks: [task("Caption")] },
        { name: "Client approval", tasks: [task("Send for OK")] },
      ],
    } as any;
    const aligned = alignPlan(plan, staged);
    expect(aligned.lists.map((list: any) => [list.name, list.tasks.map((t: any) => t.title)])).toEqual([
      ["Ideas", ["Reel idea"]],
      ["Drafting", ["Caption", "Send for OK"]],
    ]);
    expect(mergePlan(aligned, staged).newLists).toEqual([]);
  });
});


describe("AI board draft timelines", () => {
  test("keeps dates only when the user gave a timeline", () => {
    expect(hasTimeline("Website for a bakery, launch in 4 weeks")).toBe(true);
    expect(hasTimeline("Needs to be done by Friday")).toBe(true);
    expect(hasTimeline("Q1 roadmap for the app")).toBe(true);
    expect(hasTimeline("Track my team: sales, tech and marketing")).toBe(false);
    expect(hasTimeline("Everyone updates what they're working on")).toBe(false);
  });
});
