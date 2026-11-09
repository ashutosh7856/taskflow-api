import { describe, expect, test } from "bun:test";

import {
  estimateAiCostMicrousd,
  extractResponseText,
  limitAiInput,
} from "./openai";

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

  test("estimates model spend in millionths of a dollar", () => {
    expect(estimateAiCostMicrousd("gpt-6-luna", 10_000, 1_000)).toBe(1500);
    expect(estimateAiCostMicrousd("gpt-4o-mini", 10_000, 1_000)).toBe(2100);
    expect(estimateAiCostMicrousd("gpt-4o", 10_000, 1_000)).toBe(35_000);
  });

  test("caps oversized workspace context", () => {
    const limited = limitAiInput("x".repeat(70_000));
    expect(limited.length).toBeLessThan(61_000);
    expect(limited).toContain("Context truncated");
  });
});
