import { describe, expect, test } from "bun:test";

import { extractResponseText } from "./openai";

describe("OpenAI Responses parsing", () => {
  test("uses the convenience output_text field", () => {
    expect(extractResponseText({ output_text: "ready" })).toBe("ready");
  });

  test("reads text from the canonical output content array", () => {
    expect(
      extractResponseText({
        output: [{ content: [{ type: "output_text", text: "board plan" }] }],
      }),
    ).toBe("board plan");
  });

  test("rejects an empty model response", () => {
    expect(() => extractResponseText({ output: [] })).toThrow("empty response");
  });
});
