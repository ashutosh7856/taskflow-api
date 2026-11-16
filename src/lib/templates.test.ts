import { describe, expect, test } from "bun:test";
import { clientFields, getTemplate, mergeFields, templates } from "./templates";

describe("board templates", () => {
  test("ids, list roles and field keys are consistent", () => {
    const ids = new Set<string>();
    for (const template of templates) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      const keys = template.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
      const values = template.categories.map((category) => category.value);
      expect(new Set(values).size).toBe(values.length);
      if (template.lists.length) {
        // One finish stage, and it is last.
        expect(template.lists.filter((l) => l.role === "done")).toHaveLength(1);
        expect(template.lists.at(-1)!.role).toBe("done");
      }
      for (const field of template.fields)
        if (field.type === "select" || field.type === "multiselect")
          expect(field.options?.length).toBeGreaterThan(0);
    }
  });

  test("unknown template falls back to blank", () => {
    expect(getTemplate("nope").id).toBe("blank");
    expect(getTemplate(null).id).toBe("blank");
  });

  test("mergeFields keeps only valid values for the template", () => {
    const merged = mergeFields("social", null, {
      platforms: ["Instagram", "Myspace", "Instagram"],
      caption: "Hello",
      asset: "not a url",
      liveUrl: "https://instagram.com/p/1",
      unknown: "x",
    });
    expect(merged).toEqual({
      platforms: ["Instagram"],
      caption: "Hello",
      liveUrl: "https://instagram.com/p/1",
    });
  });

  test("mergeFields patches and clears", () => {
    const next = mergeFields(
      "writing",
      { keyword: "crm", words: 1200 },
      { words: "1500", keyword: null, draft: "" },
    );
    expect(next).toEqual({ words: 1500 });
  });

  test("clientFields hides internal fields", () => {
    const fields = clientFields("software", {
      points: "3",
      pr: "https://github.com/x/y/pull/1",
      env: "Staging",
    });
    expect(fields.map((field) => field.key)).toEqual(["env"]);
  });
});
